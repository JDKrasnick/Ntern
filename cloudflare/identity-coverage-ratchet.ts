import type { D1Database } from './types.js';

/**
 * Identity coverage is gated by a ratchet rather than an absolute bar.
 *
 * Owner decision, 2026-09-17: a fixed floor at 100% could never be met — some
 * rows have no provider-owned key to confirm (an intermediary host, a company
 * careers page, a search URL) — and a gate that is permanently red is not an
 * alarm. The ratchet keeps the invariant that matters: coverage may not fall
 * below the best value the catalog has already reached, minus a small tolerance
 * for day-to-day churn. It only ever tightens.
 */
export const IDENTITY_COVERAGE_RATCHET_TOLERANCE = 0.002;

const BASELINE_PK = 'IDENTITY#COVERAGE_BASELINE';
const BASELINE_KIND = 'identity-coverage-baseline';

/** The floor a pass must clear: the configured backstop, raised toward the stored baseline. */
export function identityCoverageFloor(
  configuredFloor: number | undefined,
  baseline: number | undefined,
): number {
  const backstop = configuredFloor ?? 0;
  if (baseline === undefined) return backstop;
  return Math.max(backstop, Math.max(0, baseline - IDENTITY_COVERAGE_RATCHET_TOLERANCE));
}

/** The baseline to store after a pass: the better of the stored value and this pass. */
export function nextIdentityCoverageBaseline(
  baseline: number | undefined,
  coverage: number | null,
): number | undefined {
  if (coverage === null || !Number.isFinite(coverage)) return baseline;
  return baseline === undefined ? coverage : Math.max(baseline, coverage);
}

export async function readIdentityCoverageBaseline(db: D1Database): Promise<number | undefined> {
  const row = await db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?')
    .bind(BASELINE_PK, 'BASELINE').first<{ value: string }>();
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as { baseline?: unknown };
    return typeof parsed.baseline === 'number' && Number.isFinite(parsed.baseline) ? parsed.baseline : undefined;
  } catch {
    return undefined;
  }
}

export async function writeIdentityCoverageBaseline(db: D1Database, baseline: number, at: string): Promise<void> {
  await db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'BASELINE', ?, ?)
    ON CONFLICT (pk, sk) DO UPDATE SET value = excluded.value`)
    .bind(BASELINE_PK, BASELINE_KIND, JSON.stringify({ baseline, updatedAt: at })).run();
}
