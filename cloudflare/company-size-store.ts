import { companyRating, companyTierScore } from '../src/company-ratings.js';
import { companySizeKey, companySizeScore, companyWebsiteDomain, lookupCompanySize,
  type CompanySizeCandidate, type CompanySizeScores } from '../src/company-size.js';
import type { D1Database } from './types.js';

interface CacheRow { company_key: string; status: string; employee_count: number | null; input_domain: string | null; expires_at: string; retry_at: string; }
export interface CompanySizeInventory extends CompanySizeCandidate {
  key: string; evidence: 'reviewed' | 'lookup' | 'size' | 'unrated'; score: number; due: boolean;
  lookupStatus?: string;
}
const DAY = 86_400_000;
const leaseKey = 'maintenance_lease:company_size';

export class D1CompanySizeStore {
  constructor(private readonly db: D1Database) {}

  private async cached(): Promise<Map<string, CacheRow>> {
    const rows = new Map<string, CacheRow>();
    let after = '';
    for (;;) {
      const page = await this.db.prepare(`SELECT company_key,status,employee_count,input_domain,expires_at,retry_at
        FROM company_size_cache WHERE company_key > ? ORDER BY company_key LIMIT 200`).bind(after).all<CacheRow>();
      for (const row of page.results) rows.set(row.company_key, row);
      if (page.results.length < 200) return rows;
      after = page.results.at(-1)!.company_key;
    }
  }

  async scores(now = new Date()): Promise<CompanySizeScores> {
    const scores = new Map<string, number>();
    for (const [key, row] of await this.cached()) {
      const score = row.status === 'matched' && row.expires_at > now.toISOString() && row.employee_count !== null
        ? companySizeScore(row.employee_count) : undefined;
      if (score !== undefined) scores.set(key, score);
    }
    return scores;
  }

  /** Covers every open admitted role, including roles not yet projected. Reads
   * only names, counts and existing employer domains, never posting bodies. */
  async inventory(now = new Date()): Promise<CompanySizeInventory[]> {
    const cached = await this.cached();
    const companies = new Map<string, CompanySizeCandidate & { domains: Set<string> }>();
    let after = '';
    for (;;) {
      const page = await this.db.prepare(`SELECT json_extract(job.value,'$.company') AS company, COUNT(*) AS roles,
        MIN(employer.website_domain) AS min_domain, MAX(employer.website_domain) AS max_domain
        FROM catalog_items AS job LEFT JOIN canonical_employers AS employer
          ON employer.id = json_extract(job.value,'$.admission.canonicalEmployer.id')
        WHERE job.kind='internship' AND job.catalog_state='OPEN' AND json_extract(job.value,'$.company') > ?
        GROUP BY json_extract(job.value,'$.company') ORDER BY company LIMIT 200`).bind(after)
        .all<{ company: string; roles: number; min_domain: string | null; max_domain: string | null }>();
      for (const row of page.results) {
        const key = companySizeKey(row.company);
        if (!key) continue;
        const candidate = companies.get(key) ?? { company: row.company, roles: 0, domains: new Set<string>() };
        candidate.roles += row.roles;
        for (const value of [row.min_domain, row.max_domain]) {
          const domain = companyWebsiteDomain(value);
          if (domain) candidate.domains.add(domain);
        }
        companies.set(key, candidate);
      }
      if (page.results.length < 200) break;
      after = page.results.at(-1)!.company;
    }
    const timestamp = now.toISOString();
    return [...companies].map(([key, candidate]) => {
      const domain = candidate.domains.size === 1 ? [...candidate.domains][0] : undefined;
      const rating = companyRating(candidate.company);
      const tier = companyTierScore(candidate.company);
      const cache = cached.get(key);
      const size = cache?.status === 'matched' && cache.expires_at > timestamp && cache.employee_count !== null
        ? companySizeScore(cache.employee_count) : undefined;
      return { key, company: candidate.company, roles: candidate.roles, ...(domain ? { domain } : {}),
        evidence: rating ? 'reviewed' as const : tier !== undefined ? 'lookup' as const : size !== undefined ? 'size' as const : 'unrated' as const,
        score: rating ? rating.career * .7 + rating.business * .3 : tier ?? size ?? 50,
        due: !rating && tier === undefined && (!cache || cache.retry_at <= timestamp || (domain !== undefined && domain !== cache.input_domain)),
        ...(cache ? { lookupStatus: cache.status } : {}) };
    }).sort((a, b) => b.roles - a.roles || a.key.localeCompare(b.key));
  }

  async refresh(apiKey: string | undefined, options: { limit?: number; now?: Date; fetcher?: typeof fetch } = {}) {
    const result = { attempted: 0, matched: 0, unmatched: 0, errors: 0, skipped: '' };
    if (!apiKey?.trim()) return { ...result, skipped: 'missing-key' };
    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const limit = Math.min(25, Math.max(1, Math.trunc(options.limit ?? 5) || 5));
    const owner = crypto.randomUUID();
    const lease = await this.db.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      WHERE json_extract(system_state.value,'$.expiresAt') <= ?`)
      .bind(leaseKey, JSON.stringify({ owner, expiresAt: now.getTime() + 16 * 60_000 }), timestamp, now.getTime()).run();
    if (lease.meta.changes !== 1) return { ...result, skipped: 'busy-or-backoff' };
    let backoff = false;
    try {
      const candidates = (await this.inventory(now)).filter(candidate => candidate.due).slice(0, limit);
      for (const candidate of candidates) {
        const lookup = await lookupCompanySize(candidate, apiKey, options.fetcher);
        result.attempted++;
        result[lookup.status === 'error' ? 'errors' : lookup.status]++;
        const expires = new Date(now.getTime() + (lookup.status === 'matched' ? 30 * DAY : lookup.status === 'unmatched' ? 7 * DAY : 60 * 60_000)).toISOString();
        await this.db.prepare(`INSERT INTO company_size_cache
          (company_key,company_name,input_domain,status,employee_count,provider_id,checked_at,expires_at,retry_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(company_key) DO UPDATE SET
          company_name=excluded.company_name,input_domain=excluded.input_domain,status=excluded.status,
          employee_count=excluded.employee_count,provider_id=excluded.provider_id,checked_at=excluded.checked_at,
          expires_at=excluded.expires_at,retry_at=excluded.retry_at`)
          .bind(candidate.key, candidate.company, candidate.domain ?? null, lookup.status,
            lookup.status === 'matched' ? lookup.employeeCount : null, lookup.status === 'matched' ? lookup.providerId : null,
            timestamp, expires, expires).run();
        if (lookup.status === 'error') {
          // Stop the whole batch on provider errors. A shared pause prevents every
          // cron invocation (or overlapping operator) from retrying a broken key.
          result.skipped = lookup.reason;
          await this.db.prepare(`UPDATE system_state SET value=?,updated_at=? WHERE key=? AND json_extract(value,'$.owner')=?`)
            .bind(JSON.stringify({ owner, expiresAt: now.getTime() + 60 * 60_000 }), timestamp, leaseKey, owner).run();
          backoff = true;
          break;
        }
      }
      return result;
    } finally {
      if (!backoff) await this.db.prepare("DELETE FROM system_state WHERE key=? AND json_extract(value,'$.owner')=?").bind(leaseKey, owner).run();
    }
  }
}
