import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';

/** Browser allocation/connection failures are infrastructure failures, not page evidence. */
export class DestinationBrowserUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'DestinationBrowserUnavailable';
  }
}

export async function acquireDestinationBrowser(binding: BrowserWorker) {
  try {
    // launch() allocates a session before connecting. Retrying launch after a
    // connection race allocates another browser and worsens a capacity outage.
    const { sessionId } = await puppeteer.acquire(binding);
    try {
      return await puppeteer.connect(binding, sessionId);
    } catch {
      // A newly allocated session may not yet accept its websocket connection.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return await puppeteer.connect(binding, sessionId);
    }
  } catch (error) {
    throw new DestinationBrowserUnavailable(error);
  }
}
