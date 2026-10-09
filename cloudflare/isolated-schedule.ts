import type { ServiceBinding } from './split.js';
import type { ScheduledController } from './types.js';

export async function forwardIsolatedSchedule(binding: ServiceBinding | undefined, event: ScheduledController): Promise<void> {
  if (!binding) throw new Error('Isolated scheduled service binding missing');
  const response = await binding.fetch(new Request('https://isolated.internal/internal/scheduled', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cron: event.cron, scheduledTime: event.scheduledTime }),
  }));
  if (!response.ok) {
    if (response.status === 503 && response.headers.get('Retry-After') === '600'
      && ['1,11,21,31,41,51 * * * *', '5,15,25,35,45,55 * * * *', '1-51/10 * * * *', '4,14,24,34,44,54 * * * *', '4-54/10 * * * *'].includes(event.cron)) {
      let deferred: { completed?: unknown; deferred?: unknown; failureClass?: unknown } | null;
      try { deferred = await response.json() as typeof deferred; } catch { deferred = null; }
      if (deferred?.completed === false && deferred.deferred === true
        && typeof deferred.failureClass === 'string'
        && ['r2-internal', 'd1-overloaded', 'd1-internal', 'd1-stalled'].includes(deferred.failureClass)) {
        console.warn(JSON.stringify({ event: 'isolated_catalog_projection_deferred', cron: event.cron,
          failureClass: deferred.failureClass, retryAfterSeconds: 600 }));
        return;
      }
    }
    throw new Error(`Isolated scheduled service failed (${response.status})`);
  }
  const result = await response.json() as { completed?: boolean };
  if (result.completed !== true) throw new Error('Isolated scheduled service did not complete');
}

/** Only private service bindings reach these Workers; their public routes and previews stay disabled. */
export async function isolatedScheduleRequest(request: Request, crons: readonly string[]): Promise<ScheduledController | undefined> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/internal/scheduled') return undefined;
  const body = await request.text();
  if (body.length > 1024) return undefined;
  try {
    const event = JSON.parse(body) as { cron?: unknown; scheduledTime?: unknown };
    if (typeof event.cron !== 'string' || !crons.includes(event.cron)
      || typeof event.scheduledTime !== 'number' || !Number.isSafeInteger(event.scheduledTime)
      || event.scheduledTime < 0 || event.scheduledTime > 8_640_000_000_000_000) return undefined;
    return { cron: event.cron, scheduledTime: event.scheduledTime };
  } catch { return undefined; }
}
