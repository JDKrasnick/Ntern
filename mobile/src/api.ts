import AsyncStorage from '@react-native-async-storage/async-storage';
import { publicConfig } from './public-config';
import { clearSession, restoreSession } from './auth';
import { sessionStorage } from './session-storage';
export { sessionStorage, type StoredAuthSession } from './session-storage';

const baseUrl = publicConfig.apiUrl.replace(/\/$/, '');
const requestTimeoutMs = 12_000;
const readRetryDelaysMs = [250, 500, 1_000];
const retryableReadStatuses = new Set([429, 502, 503, 504]);

export type ApiErrorKind = 'unauthorized' | 'capacity' | 'timeout' | 'offline' | 'unexpected';

export class ApiError extends Error {
  constructor(message: string, readonly kind: ApiErrorKind, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function isReadRequest(init: RequestInit) {
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchOnce(path: string, token: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('The request timed out. Check your connection and try again.', 'timeout');
    }
    if (error instanceof ApiError) throw error;
    if (error instanceof TypeError) throw new ApiError('You appear to be offline. Check your connection and try again.', 'offline');
    throw new ApiError('We couldn\'t complete that request. Please try again.', 'unexpected');
  } finally {
    clearTimeout(timeout);
  }
}

export async function api<T>(path: string, token: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  if (!baseUrl) throw new ApiError('The service is not configured.', 'unexpected');
  // Model generation and PDF compilation take far longer than a normal read, so
  // those callers pass a larger budget than the default.
  const { timeoutMs = requestTimeoutMs, ...requestInit } = init;
  const read = isReadRequest(requestInit);
  const deadline = Date.now() + timeoutMs;
  let response: Response | undefined;
  let lastTransportError: ApiError | undefined;
  for (let attempt = 0; attempt <= (read ? readRetryDelaysMs.length : 0); attempt += 1) {
    if (attempt > 0) {
      const delay = readRetryDelaysMs[attempt - 1] as number;
      if (Date.now() + delay >= deadline) break;
      await wait(delay);
    }
    try {
      response = await fetchOnce(path, token, requestInit, Math.max(1, deadline - Date.now()));
      lastTransportError = undefined;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      response = undefined;
      lastTransportError = error;
      if (!read || (error.kind !== 'offline' && error.kind !== 'timeout')) throw error;
      continue;
    }
    if (!retryableReadStatuses.has(response.status)) break;
  }
  if (!response) throw lastTransportError ?? new ApiError('We couldn\'t complete that request. Please try again.', 'unexpected');
  if (response.status === 204) return undefined as T;
  let data: T & { message?: string; code?: string };
  try {
    data = await response.json() as T & { message?: string };
  } catch {
    data = {} as T & { message?: string };
  }
  if (!response.ok) {
    if (response.status === 401) throw new ApiError('Your sign-in has expired. Please sign in again.', 'unauthorized', 401);
    if (data.code === 'ACCOUNT_DELETION_INCOMPLETE') {
      throw new ApiError(data.message ?? 'Account deletion is incomplete. Please retry.', 'unexpected', response.status);
    }
    if (retryableReadStatuses.has(response.status)) {
      throw new ApiError('The service is temporarily busy. Please try again.', 'capacity', response.status);
    }
    throw new ApiError(data.message ?? 'Request failed. Please try again.', 'unexpected', response.status);
  }
  return data;
}

function sessionError(result: Exclude<Awaited<ReturnType<typeof restoreSession>>, { status: 'authenticated' }>) {
  if (result.status === 'temporarily_unavailable') return new ApiError(result.message, 'offline');
  return new ApiError('Your sign-in has expired. Please sign in again.', 'unauthorized', 401);
}

/** Performs a GET/HEAD with one bounded refresh-and-retry after a 401. */
export async function authenticatedRead<T>(
  path: string,
  options: { method?: 'GET' | 'HEAD'; onToken?: (token: string) => void } = {},
): Promise<T> {
  let session = await restoreSession();
  if (session.status !== 'authenticated') throw sessionError(session);
  options.onToken?.(session.token);
  try {
    return await api<T>(path, session.token, { method: options.method });
  } catch (error) {
    if (!(error instanceof ApiError) || error.kind !== 'unauthorized') throw error;
  }
  session = await restoreSession({ forceRefresh: true });
  if (session.status !== 'authenticated') throw sessionError(session);
  options.onToken?.(session.token);
  try {
    return await api<T>(path, session.token, { method: options.method });
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'unauthorized') await clearSession(session.token);
    throw error;
  }
}

/** Public catalog responses are safe to retain locally for a fast first view. */
export const responseCache = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await AsyncStorage.getItem(key);
      return value ? JSON.parse(value) as T : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The live catalog remains fully usable when device storage is unavailable.
    }
  },
};
