import type { D1Database } from './types.js';

/**
 * Identity coverage is gated by a ratchet rather than an absolute bar.
 *
 * Owner decision, 2026-09-17: a fixed floor at 100% could never be met — some
 * rows have no provider-owned key to confirm (an intermediary host, a company
 * careers page, a search URL) — and a gate that is permanently red is not an
 * alarm. The ratchet keeps the invariant that matters: coverage may not fall
 * below the best value the catalog has already reached, minus padding for
 * day-to-day churn. It only ever tightens.
 *
 * The padding is one percentage point, which at the catalog's 12,904 occurrence
 * rows absorbs roughly 130 rows of ordinary movement — a source dropping rows at
 * the end of a season, a list gaining unconfirmable links — while a real
 * regression, such as a route family breaking, costs far more than that. Steady
 * erosion is still caught: the baseline only ratchets up, so small daily losses
 * accumulate against it rather than resetting it.
 *
 * Accepting a permanently lower coverage is an explicit act, not a drift: lower
 * the stored baseline row (`IDENTITY#COVERAGE_BASELINE`) deliberately when that
 * is the intended state.
 */
export const IDENTITY_COVERAGE_RATCHET_TOLERANCE = 0.01;

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
