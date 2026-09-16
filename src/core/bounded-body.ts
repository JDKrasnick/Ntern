import { SourceFetchError, categorizeFetchError } from '../sources/source-error.js';

/**
 * One byte-bounded body reader shared by every provider adapter.
 *
 * A response body is the only provider input whose size this service does not
 * control, so each provider declares a ceiling and the body is read through the
 * stream: a body without a usable `Content-Length` is stopped as soon as it
 * crosses the ceiling instead of being retained in full and then rejected. An
 * oversized body is a `capacity` failure, which routes to bounded backoff and
 * quarantine rather than being reported as a provider schema change.
 */

/** Parsed `Content-Length`, when the provider declared one. */
export function declaredBodyBytes(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

/** Streams the body under the response-size guard, stopping an oversized body early. */
export async function readBoundedBody(response: Response, limitBytes: number, subject: string): Promise<{ text: string; bytes: number }> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limitBytes) {
      throw new SourceFetchError(`${subject} response body exceeds ${limitBytes} bytes`, 'capacity');
    }
    return { text: new TextDecoder().decode(buffer), bytes: buffer.byteLength };
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limitBytes) throw new SourceFetchError(`${subject} response body exceeds ${limitBytes} bytes`, 'capacity');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    // Stop a body without a useful Content-Length as soon as it crosses the
    // limit, rather than retaining or continuing to consume its remaining data.
    try { await reader.cancel(error); } catch { /* The size error remains primary. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return { text, bytes };
}

/**
 * Reads one bounded JSON body.
 *
 * Only a body that arrived whole is evidence about the provider's schema, so a
 * parse failure over a complete body stays `json` (immediate quarantine) while a
 * failed or short transfer is `transport` (bounded retry, no quarantine). A
 * transient abort used to be relabelled "malformed JSON" and quarantined a board
 * whose payload was intact (see #236).
 */
export async function readBoundedJson(response: Response, limitBytes: number, subject: string): Promise<{ value: unknown; bytes: number }> {
  let body: { text: string; bytes: number };
  try {
    body = await readBoundedBody(response, limitBytes, subject);
  } catch (error) {
    throw categorizeFetchError(error, subject);
  }
  const declared = declaredBodyBytes(response);
  // A transfer that ends short of its declared length never delivered the board
  // the provider promised, so its bytes say nothing about the schema.
  if (declared !== undefined && body.bytes < declared) {
    throw new SourceFetchError(`${subject} response body ended after ${body.bytes} of ${declared} declared bytes`, 'transport');
  }
  try {
    return { value: JSON.parse(body.text), bytes: body.bytes };
  } catch {
    throw new SourceFetchError(`${subject} returned malformed JSON`, 'json');
  }
}
