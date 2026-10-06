import { createHash, randomBytes } from 'node:crypto';
import { catalogProjectionRoleMatches, filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter,
  type CatalogGroupRole, type CatalogProjectionPage } from '../src/catalog-groups.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, R2Bucket } from './types.js';

const prefix = 'public-catalog/v1';
const pageSize = 100;
const streamedPageBytes = 8 * 1024 * 1024;
const roleReadPageConcurrency = 4;
const filterReadPageConcurrency = 4;
const maxAgeMs = 7 * 24 * 60 * 60_000;
const encoded = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

function contentVersion(groups: CatalogGroupDetails[]): string {
  const hash = createHash('sha256');
  for (const group of groups) hash.update(JSON.stringify(group)).update('\0');
  return hash.digest('hex').slice(0, 20);
}

type Pointer = { schemaVersion: 1; version: string; pageVersion?: string; generatedAt: string; count: number; groupPages: Record<string, number>;
  /** The D1 publish's open-catalog watermark, so a reader can detect an unprojected role. */
  liveWatermark?: string };
type RetiredPointer = { schemaVersion: 0; generatedAt: string };

function offsetOf(cursor?: string): number {
  const value = Number(cursor ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Immutable pages are published before the pointer, so readers see a complete version. */
export class R2CatalogProjection {
  constructor(private readonly bucket: R2Bucket) {}

  async invalidate(generatedAt?: string): Promise<void> {
    const object = await this.bucket.get(`${prefix}/current`);
    if (!object?.etag) return;
    const previous = await this.decodeState(object.body);
    if (generatedAt && previous && previous.generatedAt > generatedAt) return;
    await this.bucket.put(`${prefix}/current`, encoded({ schemaVersion: 0, generatedAt: generatedAt ?? previous?.generatedAt ?? new Date().toISOString() }), { onlyIf: { etagMatches: object.etag } });
  }

  /** Keep complete immutable pages when only the D1 generation timestamp changed. */
  async revalidate(groups: CatalogGroupDetails[], generatedAt: string, liveWatermark?: string): Promise<void> {
    const object = await this.bucket.get(`${prefix}/current`);
    // No pointer means D1 already owns reads. Never overwrite a publication
    // that completed while pages were being checked, including invalidation.
    if (!object?.etag) return;
    const state = await this.decodeState(object.body);
    if (state && state.generatedAt > generatedAt) return;
    const previous = state?.schemaVersion === 1 ? state : undefined;
    if (!previous || previous.version !== contentVersion(groups) || !await this.pagesMatch(previous, groups)) {
      // R2 has conditional writes but no conditional delete. A tombstone hides
      // this generation atomically without deleting a concurrent newer one.
      await this.bucket.put(`${prefix}/current`, encoded({ schemaVersion: 0, generatedAt }), { onlyIf: { etagMatches: object.etag } });
      return;
    }
    await this.bucket.put(`${prefix}/current`, encoded({
      ...previous, generatedAt, liveWatermark,
    }), { onlyIf: { etagMatches: object.etag } });
  }

  private async pointer(): Promise<Pointer | undefined> {
    const object = await this.bucket.get(`${prefix}/current`);
    if (!object) return undefined;
    return this.decodePointer(object.body);
  }

  private async decodePointer(body: ReadableStream): Promise<Pointer | undefined> {
    const state = await this.decodeState(body);
    return state?.schemaVersion === 1 ? state : undefined;
  }

  private async decodeState(body: ReadableStream): Promise<Pointer | RetiredPointer | undefined> {
    let pointer: Pointer;
    try { pointer = await new Response(body).json() as Pointer; } catch { return undefined; }
    if (pointer && (pointer as { schemaVersion: number }).schemaVersion === 0 && Number.isFinite(Date.parse(pointer.generatedAt))) {
      return { schemaVersion: 0, generatedAt: pointer.generatedAt };
    }
    if (!pointer || pointer.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(pointer.version)
      || (pointer.pageVersion !== undefined && (typeof pointer.pageVersion !== 'string' || !/^[a-f0-9]{20}$/.test(pointer.pageVersion)))
      || !Number.isSafeInteger(pointer.count) || pointer.count < 0
      || !pointer.groupPages || typeof pointer.groupPages !== 'object'
      || !Number.isFinite(Date.parse(pointer.generatedAt))
      || Date.now() - Date.parse(pointer.generatedAt) > maxAgeMs) return undefined;
    return pointer;
  }

  private async page(pointer: Pointer, index: number): Promise<CatalogGroupDetails[]> {
    const object = await this.bucket.get(`${prefix}/${pointer.pageVersion ?? pointer.version}/${index}`);
    if (!object) throw new Error('R2 catalog projection page is missing');
    const groups = await new Response(object.body).json() as CatalogGroupDetails[];
    if (!Array.isArray(groups) || groups.length > pageSize) throw new Error('R2 catalog projection page is invalid');
    return groups;
  }

  /** Read one page at a time so validation never hydrates a second catalog. */
  private async pagesMatch(pointer: Pointer, groups: CatalogGroupDetails[]): Promise<boolean> {
    if (pointer.count !== groups.length || Object.keys(pointer.groupPages).length !== groups.length
      || groups.some((group, index) => pointer.groupPages[group.group.groupId] !== Math.floor(index / pageSize))) return false;
    try {
      for (let index = 0; index * pageSize < groups.length; index += 1) {
        const page = await this.page(pointer, index);
        if (JSON.stringify(page) !== JSON.stringify(groups.slice(index * pageSize, (index + 1) * pageSize))) return false;
      }
      return true;
    } catch { return false; }
  }

  async publish(groups: CatalogGroupDetails[], generatedAt: string, liveWatermark?: string): Promise<void> {
    const version = contentVersion(groups);
    const object = await this.bucket.get(`${prefix}/current`);
    let etag = object?.etag;
    const state = object ? await this.decodeState(object.body) : undefined;
    if (state && state.generatedAt > generatedAt) return;
    const previous = state?.schemaVersion === 1 ? state : undefined;
    const retained = previous?.version === version && await this.pagesMatch(previous, groups);
    if (!retained) {
      // Hide an incomplete active version before attempting its repair. A failed
      // write must leave readers on D1, rather than renewing a broken pointer.
      if (previous?.version === version) {
        if (!object?.etag) throw new Error('R2 catalog pointer ETag is missing');
        const retired = await this.bucket.put(`${prefix}/current`, encoded({ schemaVersion: 0, generatedAt }), { onlyIf: { etagMatches: object.etag } });
        if (retired === null) return;
        etag = (retired as { etag?: string } | undefined)?.etag;
        if (!etag) throw new Error('R2 catalog tombstone ETag is missing');
      }
      for (let index = 0; index * pageSize < groups.length; index += 1) {
        await this.bucket.put(`${prefix}/${version}/${index}`, encoded(groups.slice(index * pageSize, (index + 1) * pageSize)));
      }
    }
    const groupPages = Object.fromEntries(groups.map((group, index) => [group.group.groupId, Math.floor(index / pageSize)]));
    if (object && !etag) throw new Error('R2 catalog pointer ETag is missing');
    await this.bucket.put(`${prefix}/current`, encoded({
      schemaVersion: 1, version, generatedAt, count: groups.length, groupPages,
      ...(retained && previous?.pageVersion ? { pageVersion: previous.pageVersion } : {}),
      ...(liveWatermark ? { liveWatermark } : {}),
    } satisfies Pointer), { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' } });
  }

  /** Keep one page live. A private page namespace prevents an incomplete or
   * corrupt D1 scan from modifying pages already visible to readers. */
  async publishStream(source: {
    version: string; generatedAt: string; liveWatermark?: string; groups: AsyncIterable<CatalogGroupDetails>;
  }): Promise<{ groups: number; roles: number; skipped?: boolean }> {
    if (!/^[a-f0-9]{20}$/.test(source.version)) throw new Error('D1 catalog projection version is invalid');
    const object = await this.bucket.get(`${prefix}/current`);
    let etag = object?.etag;
    const state = object ? await this.decodeState(object.body) : undefined;
    if (state && state.generatedAt > source.generatedAt) return { groups: 0, roles: 0, skipped: true };
    const previous = state?.schemaVersion === 1 ? state : undefined;
    let reuse = previous?.version === source.version;
    const pageVersion = randomBytes(10).toString('hex');
    const stagedKeys: string[] = [];
    const checkedPages: string[] = [];
    const groupPages = new Map<string, number>();
    const hash = createHash('sha256');
    let page: CatalogGroupDetails[] = [], pageBytes = 2, count = 0, roles = 0, index = 0, published = false, activationUncertain = false;
    const stage = async (pageIndex: number, serialized: string) => {
      const key = `${prefix}/${pageVersion}/${pageIndex}`;
      stagedKeys.push(key);
      await this.bucket.put(key, new TextEncoder().encode(serialized).buffer as ArrayBuffer);
    };
    const flush = async (): Promise<boolean> => {
      const serialized = JSON.stringify(page);
      page = [];
      pageBytes = 2;
      if (reuse && previous) {
        let matches = false;
        let saved = '';
        try {
          const object = await this.bucket.get(`${prefix}/${previous.pageVersion ?? previous.version}/${index}`);
          if (object) {
            saved = await new Response(object.body).text();
            matches = JSON.stringify(JSON.parse(saved)) === serialized;
          }
        } catch { /* Repair this page. */ }
        if (matches) {
          checkedPages.push(createHash('sha256').update(saved).digest('hex'));
          index += 1;
          return true;
        }
        if (!etag) throw new Error('R2 catalog pointer ETag is missing');
        const retired = await this.bucket.put(`${prefix}/current`, encoded({ schemaVersion: 0, generatedAt: source.generatedAt }),
          { onlyIf: { etagMatches: etag } });
        if (retired === null) return false;
        etag = (retired as { etag?: string } | undefined)?.etag;
        if (!etag) throw new Error('R2 catalog tombstone ETag is missing');
        reuse = false;
        // Earlier pages were validated against this same D1 stream. Copy only
        // one at a time, and reject any mutation since that validation.
        for (let prior = 0; prior < index; prior += 1) {
          const object = await this.bucket.get(`${prefix}/${previous.pageVersion ?? previous.version}/${prior}`);
          if (!object) throw new Error('R2 catalog page disappeared during repair');
          const saved = await new Response(object.body).text();
          if (createHash('sha256').update(saved).digest('hex') !== checkedPages[prior]) {
            throw new Error('R2 catalog page changed during repair');
          }
          await stage(prior, saved);
        }
      }
      await stage(index, serialized);
      index += 1;
      return true;
    };
    try {
      for await (const group of source.groups) {
        if (groupPages.has(group.group.groupId)) throw new Error('D1 catalog projection has duplicate groups');
        const serialized = JSON.stringify(group);
        pageBytes += new TextEncoder().encode(serialized).byteLength + (page.length ? 1 : 0);
        if (pageBytes > streamedPageBytes) throw new Error('R2 catalog projection page exceeds its memory budget');
        hash.update(serialized).update('\0');
        groupPages.set(group.group.groupId, Math.floor(count / pageSize));
        count += 1; roles += group.roles.length;
        page.push(group);
        if (page.length === pageSize && !await flush()) return { groups: count, roles, skipped: true };
      }
      if (page.length && !await flush()) return { groups: count, roles, skipped: true };
      if (hash.digest('hex').slice(0, 20) !== source.version) throw new Error('D1 catalog projection stream does not match its manifest');
      if (object && !etag) throw new Error('R2 catalog pointer ETag is missing');
      activationUncertain = true;
      const result = await this.bucket.put(`${prefix}/current`, encoded({
        schemaVersion: 1, version: source.version, generatedAt: source.generatedAt, count,
        groupPages: Object.fromEntries(groupPages),
        ...(reuse && previous?.pageVersion ? { pageVersion: previous.pageVersion } : {}),
        ...(!reuse && count ? { pageVersion } : {}),
        ...(source.liveWatermark ? { liveWatermark: source.liveWatermark } : {}),
      } satisfies Pointer), { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' } });
      activationUncertain = false;
      published = result !== null;
      return { groups: count, roles, ...(!published ? { skipped: true } : {}) };
    } finally {
      // A lost activation acknowledgement may already have exposed this prefix,
      // and another writer may retain it. Delete only proven unpublished pages.
      if (!published && !activationUncertain) {
        for (let start = 0; start < stagedKeys.length; start += 4) {
          await Promise.all(stagedKeys.slice(start, start + 4).map(async key => {
            try { await this.bucket.delete(key); } catch { /* Rebuildable orphan; preserve the publication error. */ }
          }));
        }
      }
    }
  }

  /** The watermark of the published version, for a reader that holds no page. */
  async liveWatermark(): Promise<string | undefined> {
    return (await this.pointer())?.liveWatermark;
  }

  async generatedAt(): Promise<string | undefined> {
    return (await this.pointer())?.generatedAt;
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

  private async currentGeneration(): Promise<boolean> {
    const [r2, d1] = await Promise.all([this.projection.generatedAt(), this.catalogProjectionGeneratedAt()]);
    return r2 !== undefined && r2 === d1;
  }

  override async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    try {
      if (!await this.currentGeneration()) return super.listCatalogProjection(cursor, limit);
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
      if (!await this.currentGeneration()) return super.listCatalogProjectionFiltered(cursor, limit, filter);
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
      if (!await this.currentGeneration()) return super.listCatalogProjectionRoles(filter, range);
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
      if (!await this.currentGeneration()) return super.getCatalogProjectionGroup(groupId);
      if (await this.liveOverlayFor(await this.projection.liveWatermark())) return super.getCatalogProjectionGroup(groupId);
      return await this.projection.group(groupId) ?? await super.getCatalogProjectionGroup(groupId);
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_catalog_projection_read_failed', error: String(error) }));
      return super.getCatalogProjectionGroup(groupId);
    }
  }
}
