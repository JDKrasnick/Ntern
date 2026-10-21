import type { D1Database, Queue } from './types.js';

type Metrics = Awaited<ReturnType<NonNullable<Queue['metrics']>>>;
// Cloudflare deletes messages at retention expiry; no queue can retain them
// beyond 14 days. Do not turn an impossible provider timestamp into a work age.
// https://developers.cloudflare.com/queues/platform/limits/
const maximumRetentionMs = 14 * 86_400_000;
const unknownAgeGraceMs = 30 * 60_000;

/** Keep the grace period across isolates and deployments. A healthy sample
 * clears it; an unreadable baseline fails the maintenance step visibly. */
export async function observeDestinationUnknownAge(db: D1Database, unknown: boolean, now: Date): Promise<boolean> {
  const pk = 'OPERATIONS#DESTINATION_AGE';
  if (!unknown) {
    await db.prepare("DELETE FROM catalog_items WHERE pk = ? AND sk = 'UNKNOWN_SINCE'").bind(pk).run();
    return false;
  }
  await db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value)
    VALUES (?, 'UNKNOWN_SINCE', 'operations-destination-age', ?)
    ON CONFLICT(pk, sk) DO NOTHING`).bind(pk, now.toISOString()).run();
  const row = await db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'UNKNOWN_SINCE'")
    .bind(pk).first<{ value: string }>();
  const since = row ? Date.parse(row.value) : NaN;
  // Corrupt or future state must not extend the grace indefinitely.
  return !Number.isFinite(since) || since > now.getTime() || now.getTime() - since >= unknownAgeGraceMs;
}

function age(metrics: Metrics | undefined, now: Date): number | undefined {
  if (!metrics || !Number.isSafeInteger(metrics.backlogCount) || metrics.backlogCount < 0) return undefined;
  if (metrics.backlogCount === 0) return 0;
  const timestamp = metrics.oldestMessageTimestamp?.getTime();
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  const elapsed = now.getTime() - timestamp;
  return elapsed >= 0 && elapsed <= maximumRetentionMs ? elapsed : undefined;
}

/** Confirm alarming binding metrics independently, without pulling, leasing,
 * acknowledging, or changing queue messages. A failed confirmation must remain
 * visible; it cannot silently turn a real backlog into a healthy result. */
export async function destinationQueueHealth(
  primary: Metrics | undefined,
  now: () => Date,
  alertAgeMs: number,
  confirm: () => Promise<Metrics>,
  observeUnknownAge: (unknown: boolean) => Promise<boolean> = async () => true,
): Promise<{ metrics: Metrics | undefined; ageMs: number | undefined; signals: string[] }> {
  let metrics = primary;
  let ageMs = age(primary, now());
  let confirmedUnknown = false;
  const signals: string[] = [];
  if (ageMs === undefined || ageMs >= alertAgeMs) {
    try {
      metrics = await confirm();
      ageMs = age(metrics, now());
      if (ageMs === undefined) {
        // Zero/missing timestamps are a documented "unknown", even with a
        // nonempty backlog. They do not establish either freshness or staleness.
        const timestamp = metrics.oldestMessageTimestamp?.getTime();
        const unknown = Number.isSafeInteger(metrics.backlogCount) && metrics.backlogCount > 0
          && (timestamp === undefined || timestamp === 0);
        if (!unknown) signals.push('destination-verification-metrics-invalid');
        else {
          confirmedUnknown = true;
          if (await observeUnknownAge(true)) signals.push('destination-verification-metrics-unavailable');
          // An unknown confirmation cannot disprove a plausible stale binding
          // observation while REST still reports outstanding work.
          const primaryAge = age(primary, now());
          if (primaryAge !== undefined && primaryAge >= alertAgeMs) {
            metrics = primary;
            ageMs = primaryAge;
          }
        }
      }
    } catch {
      // Retain a plausible old primary observation when REST is unavailable.
      signals.push('destination-verification-metrics-unavailable');
    }
  }
  if (ageMs !== undefined && !confirmedUnknown) await observeUnknownAge(false);
  if (ageMs !== undefined && ageMs >= alertAgeMs && metrics && metrics.backlogCount > 0) {
    signals.push('destination-verification-age');
  }
  return { metrics, ageMs, signals };
}
