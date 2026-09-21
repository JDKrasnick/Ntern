import { describe, expect, it, vi } from 'vitest';
import ingestionWorker from '../cloudflare/ingestion-worker.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { Environment } from '../cloudflare/worker.js';

vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: vi.fn() } }));

function reconnectingD1(): { db: D1Database; first: ReturnType<typeof vi.fn> } {
  const first = vi.fn().mockRejectedValueOnce(new Error('Connection closed')).mockResolvedValue(null);
  const statement = { bind: vi.fn(), first, all: vi.fn(), run: vi.fn() } as unknown as D1PreparedStatement;
  return { db: { prepare: vi.fn(() => statement), batch: vi.fn() }, first };
}

describe('destination queue D1 resilience integration', () => {
  it.each([
    ['intern-notifs-destination-verification', 'retry'],
    ['intern-notifs-shadow-extraction', 'ack'],
  ] as const)('reconnects D1 in the %s consumer before its queue-specific settlement', async (queue, settlement) => {
    const { db, first } = reconnectingD1();
    const message = { id: `reconnect-${settlement}`, body: 'not-json', ack: vi.fn(), retry: vi.fn() };

    await ingestionWorker.queue({ queue, messages: [message] }, { DB: db } as Environment);

    expect(first).toHaveBeenCalledTimes(2);
    if (settlement === 'retry') {
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(message.ack).not.toHaveBeenCalled();
    } else {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });
});
