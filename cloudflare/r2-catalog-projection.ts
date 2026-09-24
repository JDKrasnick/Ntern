import { createHash } from 'node:crypto';
import { catalogProjectionRoleMatches, filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter,
  type CatalogGroupRole, type CatalogProjectionPage } from '../src/catalog-groups.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, R2Bucket } from './types.js';

const prefix = 'public-catalog/v1';
const pageSize = 100;
const roleReadPageConcurrency = 4;
const maxAgeMs = 7 * 24 * 60 * 60_000;
const encoded = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

type Pointer = { schemaVersion: 1; version: string; generatedAt: string; count: number; groupPages: Record<string, number> };

function offsetOf(cursor?: string): number {
  const value = Number(cursor ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Immutable pages are published before the pointer, so readers see a complete version. */
export class R2CatalogProjection {
  constructor(private readonly bucket: R2Bucket) {}

  async invalidate(): Promise<void> { await this.bucket.delete(`${prefix}/current`); }

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

  async publish(groups: CatalogGroupDetails[], generatedAt: string): Promise<void> {
    const hash = createHash('sha256');
    for (const group of groups) hash.update(JSON.stringify(group)).update('\0');
    const version = hash.digest('hex').slice(0, 20);
    const previous = await this.pointer();
    if (previous?.version !== version) {
      for (let index = 0; index * pageSize < groups.length; index += 1) {
        await this.bucket.put(`${prefix}/${version}/${index}`, encoded(groups.slice(index * pageSize, (index + 1) * pageSize)));
      }
    }
    const groupPages = Object.fromEntries(groups.map((group, index) => [group.group.groupId, Math.floor(index / pageSize)]));
    await this.bucket.put(`${prefix}/current`, encoded({ schemaVersion: 1, version, generatedAt, count: groups.length, groupPages } satisfies Pointer));
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
    return { groups: groups.slice(0, limit), ...(offset + limit < pointer.count ? { cursor: String(offset + limit) } : {}) };
  }

  async listFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.pointer();
    if (!pointer) return undefined;
    const offset = offsetOf(cursor);
    const matched: CatalogGroupDetails[] = [];
    let seen = 0;
    for (let index = 0; index * pageSize < pointer.count && matched.length <= limit; index += 1) {
      for (const group of await this.page(pointer, index)) {
        const filtered = filterCatalogGroupDetails([group], filter)[0];
        if (!filtered) continue;
        if (seen++ < offset) continue;
        matched.push(filtered);
        if (matched.length > limit) break;
      }
    }
    return { groups: matched.slice(0, limit), ...(matched.length > limit ? { cursor: String(offset + limit) } : {}) };
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

/** Keep D1 authoritative when the rebuildable R2 projection is absent or damaged. */
export class R2CatalogReadStore extends D1InternshipStore {
  private readonly projection: R2CatalogProjection;

  constructor(db: D1Database, bucket: R2Bucket) {
    super(db);
    this.projection = new R2CatalogProjection(bucket);
  }

  override async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    try { return await this.projection.list(cursor, limit) ?? await super.listCatalogProjection(cursor, limit); }
    catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjection(cursor, limit);
    }
  }

  override async listCatalogProjectionFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    try { return await this.projection.listFiltered(cursor, limit, filter) ?? await super.listCatalogProjectionFiltered(cursor, limit, filter); }
    catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjectionFiltered(cursor, limit, filter);
    }
  }

  override async listCatalogProjectionRoles(filter: CatalogGroupFilter, range: { from?: string; to?: string }): Promise<CatalogGroupRole[] | undefined> {
    try { return await this.projection.roles(filter, range) ?? await super.listCatalogProjectionRoles(filter, range); }
    catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.listCatalogProjectionRoles(filter, range);
    }
  }

  override async getCatalogProjectionGroup(groupId: string): Promise<CatalogGroupDetails | undefined> {
    try { return await this.projection.group(groupId) ?? await super.getCatalogProjectionGroup(groupId); }
    catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.getCatalogProjectionGroup(groupId);
    }
  }
}
