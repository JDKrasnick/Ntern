import { createHash } from 'node:crypto';
import { catalogProjectionRoleMatches, filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter,
  type CatalogGroupRole, type CatalogProjectionPage } from '../src/catalog-groups.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, R2Bucket } from './types.js';

const prefix = 'public-catalog/v1';
const pageSize = 100;
const roleReadPageConcurrency = 4;
const filterReadPageConcurrency = 4;
const maxAgeMs = 7 * 24 * 60 * 60_000;
const encoded = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

function contentVersion(groups: CatalogGroupDetails[]): string {
  const hash = createHash('sha256');
  for (const group of groups) hash.update(JSON.stringify(group)).update('\0');
  return hash.digest('hex').slice(0, 20);
}

type Pointer = { schemaVersion: 1; version: string; generatedAt: string; count: number; groupPages: Record<string, number>;
  /** The D1 publish's open-catalog watermark, so a reader can detect an unprojected role. */
  liveWatermark?: string };

function offsetOf(cursor?: string): number {
  const value = Number(cursor ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Immutable pages are published before the pointer, so readers see a complete version. */
export class R2CatalogProjection {
  constructor(private readonly bucket: R2Bucket) {}

  async invalidate(): Promise<void> { await this.bucket.delete(`${prefix}/current`); }

  /** Keep complete immutable pages when only the D1 generation timestamp changed. */
  async revalidate(groups: CatalogGroupDetails[], generatedAt: string, liveWatermark?: string): Promise<void> {
    const previous = await this.pointer();
    if (!previous || previous.version !== contentVersion(groups)) {
      await this.invalidate();
      return;
    }
    await this.bucket.put(`${prefix}/current`, encoded({
      ...previous, generatedAt, liveWatermark,
    }));
  }

  private async pointer(): Promise<Pointer | undefined> {
    const object = await this.bucket.get(`${prefix}/current`);
    if (!object) return undefined;
    const pointer = await new Response(object.body).json() as Pointer;
    if (pointer.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(pointer.version)
      || !Number.isSafeInteger(pointer.count) || pointer.count < 0
      || !pointer.groupPages || typeof pointer.groupPages !== 'object'
      || !Number.isFinite(Date.parse(pointer.generatedAt))
      || Date.now() - Date.parse(pointer.generatedAt) > maxAgeMs) return undefined;
    return pointer;
  }

  private async page(pointer: Pointer, index: number): Promise<CatalogGroupDetails[]> {
    const object = await this.bucket.get(`${prefix}/${pointer.version}/${index}`);
    if (!object) throw new Error('R2 catalog projection page is missing');
    const groups = await new Response(object.body).json() as CatalogGroupDetails[];
    if (!Array.isArray(groups) || groups.length > pageSize) throw new Error('R2 catalog projection page is invalid');
    return groups;
  }

  async publish(groups: CatalogGroupDetails[], generatedAt: string, liveWatermark?: string): Promise<void> {
    const version = contentVersion(groups);
    const previous = await this.pointer();
    if (previous?.version !== version) {
      for (let index = 0; index * pageSize < groups.length; index += 1) {
        await this.bucket.put(`${prefix}/${version}/${index}`, encoded(groups.slice(index * pageSize, (index + 1) * pageSize)));
      }
    }
    const groupPages = Object.fromEntries(groups.map((group, index) => [group.group.groupId, Math.floor(index / pageSize)]));
    await this.bucket.put(`${prefix}/current`, encoded({
      schemaVersion: 1, version, generatedAt, count: groups.length, groupPages,
      ...(liveWatermark ? { liveWatermark } : {}),
    } satisfies Pointer));
  }

  /** The watermark of the published version, for a reader that holds no page. */
  async liveWatermark(): Promise<string | undefined> {
    return (await this.pointer())?.liveWatermark;
  }

  async list(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    const offset = offsetOf(cursor);
    const groups: CatalogGroupDetails[] = [];
    let index = Math.floor(offset / pageSize);
    while (groups.length < limit + 1 && index * pageSize < pointer.count) {
      const page = await this.page(pointer, index);
      groups.push(...page.slice(index === Math.floor(offset / pageSize) ? offset % pageSize : 0));
      index += 1;
    }
    return { groups: groups.slice(0, limit), ...(offset + limit < pointer.count ? { cursor: String(offset + limit) } : {}),
      ...(pointer.liveWatermark ? { liveWatermark: pointer.liveWatermark } : {}) };
  }

  async listFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    const offset = offsetOf(cursor);
    const matched: CatalogGroupDetails[] = [];
    let seen = 0;
    const totalPages = Math.ceil(pointer.count / pageSize);
    // A narrowed read has to inspect every group because the projection is
    // ordered for breadth, not for a facet. Read the pages in bounded batches,
    // then filter them in page order so the matched-count cursor stays exact.
    for (let first = 0; first < totalPages && matched.length <= limit; first += filterReadPageConcurrency) {
      const pages = await Promise.all(Array.from(
        { length: Math.min(filterReadPageConcurrency, totalPages - first) },
        (_, index) => this.page(pointer, first + index),
      ));
      for (const groups of pages) {
        for (const group of groups) {
          const filtered = filterCatalogGroupDetails([group], filter)[0];
          if (!filtered) continue;
          if (seen++ < offset) continue;
          matched.push(filtered);
          if (matched.length > limit) break;
        }
        if (matched.length > limit) break;
      }
    }
    return { groups: matched.slice(0, limit), ...(matched.length > limit ? { cursor: String(offset + limit) } : {}),
      ...(pointer.liveWatermark ? { liveWatermark: pointer.liveWatermark } : {}) };
  }

  async roles(filter: CatalogGroupFilter, range: { from?: string; to?: string }): Promise<CatalogGroupRole[] | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    const roles: CatalogGroupRole[] = [];
    const from = range.from ? new Date(Date.parse(range.from) - 86_400_000).toISOString().slice(0, 10) : undefined;
    const to = range.to ? new Date(Date.parse(range.to) + 86_400_000).toISOString().slice(0, 10) : undefined;
    for (let first = 0; first * pageSize < pointer.count; first += roleReadPageConcurrency) {
      const pages = await Promise.all(Array.from(
        { length: Math.min(roleReadPageConcurrency, Math.ceil(pointer.count / pageSize) - first) },
        (_, offset) => this.page(pointer, first + offset),
      ));
      for (const page of pages) {
        for (const group of page) {
          roles.push(...group.roles.filter((role) => role.releaseDay && catalogProjectionRoleMatches(role, filter)
            && (!from || role.releaseDay >= from)
            && (!to || role.releaseDay <= to)));
        }
      }
    }
    return roles;
  }

  async group(groupId: string): Promise<CatalogGroupDetails | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    if (!Object.prototype.hasOwnProperty.call(pointer.groupPages, groupId)) return undefined;
    const index = pointer.groupPages[groupId];
    if (!Number.isSafeInteger(index) || index < 0 || index * pageSize >= pointer.count) throw new Error('R2 catalog projection index is invalid');
    return (await this.page(pointer, index)).find((group) => group.group.groupId === groupId);
  }
}

/**
 * Keep D1 authoritative when the rebuildable R2 projection is absent or damaged.
 *
 * R2 pages are immutable, so they cannot carry a role published after the
 * publish that wrote them. A read therefore probes the D1 delta with the
 * watermark the page names, and hands the request to the D1 path when unprojected
 * roles exist. The probe is one indexed range query, answers empty in the
 * ordinary current state, and keeps the R2 fast path for every other read.
 */
export class R2CatalogReadStore extends D1InternshipStore {
  private readonly projection: R2CatalogProjection;

  constructor(db: D1Database, bucket: R2Bucket) {
    super(db);
    this.projection = new R2CatalogProjection(bucket);
  }

  override async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    try {
      const page = await this.projection.list(cursor, limit);
      if (!page) return super.listCatalogProjection(cursor, limit);
      return (await this.liveOverlayFor(page.liveWatermark)) ? super.listCatalogProjection(cursor, limit) : page;
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjection(cursor, limit);
    }
  }

  override async listCatalogProjectionFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    try {
      const page = await this.projection.listFiltered(cursor, limit, filter);
      if (!page) return super.listCatalogProjectionFiltered(cursor, limit, filter);
      return (await this.liveOverlayFor(page.liveWatermark)) ? super.listCatalogProjectionFiltered(cursor, limit, filter) : page;
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjectionFiltered(cursor, limit, filter);
    }
  }

  override async listCatalogProjectionRoles(filter: CatalogGroupFilter, range: { from?: string; to?: string }): Promise<CatalogGroupRole[] | undefined> {
    try {
      const roles = await this.projection.roles(filter, range);
      if (!roles) return super.listCatalogProjectionRoles(filter, range);
      return (await this.liveOverlayFor(await this.projection.liveWatermark())) ? super.listCatalogProjectionRoles(filter, range) : roles;
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjectionRoles(filter, range);
    }
  }

  override async getCatalogProjectionGroup(groupId: string): Promise<CatalogGroupDetails | undefined> {
    try {
      if (await this.liveOverlayFor(await this.projection.liveWatermark())) return super.getCatalogProjectionGroup(groupId);
      return await this.projection.group(groupId) ?? await super.getCatalogProjectionGroup(groupId);
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.getCatalogProjectionGroup(groupId);
    }
  }
}
