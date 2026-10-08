import type { ServiceBinding } from './split.js';
import type { ScheduledController } from './types.js';

export async function forwardIsolatedSchedule(binding: ServiceBinding | undefined, event: ScheduledController): Promise<void> {
  if (!binding) throw new Error('Isolated scheduled service binding missing');
  const response = await binding.fetch(new Request('https://isolated.internal/internal/scheduled', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cron: event.cron, scheduledTime: event.scheduledTime }),
  }));
  if (!response.ok) throw new Error(`Isolated scheduled service failed (${response.status})`);
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
