import type { Queue } from './types.js';

type Metrics = Awaited<ReturnType<NonNullable<Queue['metrics']>>>;
// Cloudflare deletes messages at retention expiry; no queue can retain them
// beyond 14 days. Do not turn an impossible provider timestamp into a work age.
// https://developers.cloudflare.com/queues/platform/limits/
const maximumRetentionMs = 14 * 86_400_000;

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
): Promise<{ metrics: Metrics | undefined; ageMs: number | undefined; signals: string[] }> {
  let metrics = primary;
  let ageMs = age(primary, now());
  const signals: string[] = [];
  if (ageMs === undefined || ageMs >= alertAgeMs) {
    try {
      metrics = await confirm();
      ageMs = age(metrics, now());
      if (ageMs === undefined) signals.push('destination-verification-metrics-invalid');
    } catch {
      // Retain a plausible old primary observation when REST is unavailable.
      signals.push('destination-verification-metrics-unavailable');
    }
  }
  if (ageMs !== undefined && ageMs >= alertAgeMs && metrics && metrics.backlogCount > 0) {
    signals.push('destination-verification-age');
  }
  return { metrics, ageMs, signals };
}
