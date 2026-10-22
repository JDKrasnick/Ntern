import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDestinationBrowser, DestinationBrowserUnavailable } from '../cloudflare/destination-browser.js';
import type { BrowserWorker } from '@cloudflare/puppeteer';

const { acquire, connect } = vi.hoisted(() => ({ acquire: vi.fn(), connect: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { acquire, connect } }));
const binding = {} as BrowserWorker;

describe('destination browser acquisition', () => {
  beforeEach(() => { vi.useFakeTimers(); acquire.mockReset(); connect.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('connects to the one allocated session', async () => {
    const browser = { newPage: vi.fn(), close: vi.fn() };
    acquire.mockResolvedValue({ sessionId: 'session-1' }); connect.mockResolvedValue(browser);
    await expect(acquireDestinationBrowser(binding)).resolves.toBe(browser);
    expect(acquire).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledExactlyOnceWith(binding, 'session-1');
  });

  it('reconnects to the same session after a startup race without allocating another browser', async () => {
    const browser = { close: vi.fn() };
    acquire.mockResolvedValue({ sessionId: 'session-1' });
    connect.mockRejectedValueOnce(new Error("Cannot read properties of null (reading 'accept')")).mockResolvedValueOnce(browser);
    const pending = acquireDestinationBrowser(binding);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(browser);
    expect(acquire).toHaveBeenCalledOnce();
    expect(connect.mock.calls).toEqual([[binding, 'session-1'], [binding, 'session-1']]);
  });

  it('reports unavailable capacity without allocating in a loop', async () => {
    const cause = new Error('Unable to create new browser: code: 503: message: No browser available');
    acquire.mockRejectedValue(cause);
    await expect(acquireDestinationBrowser(binding)).rejects.toMatchObject({ name: 'DestinationBrowserUnavailable', cause });
    expect(acquire).toHaveBeenCalledOnce(); expect(connect).not.toHaveBeenCalled();
  });

  it('bounds connection retries and preserves the final diagnostic', async () => {
    acquire.mockResolvedValue({ sessionId: 'session-1' });
    connect.mockRejectedValue(new Error('Browser session is not ready'));
    const result = acquireDestinationBrowser(binding).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeInstanceOf(DestinationBrowserUnavailable);
    expect((await result).message).toBe('Browser session is not ready');
    expect(acquire).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(2);
  });
});
