import type { D1Database } from './types.js';

const encoder = new TextEncoder();
// Cloudflare Workers caps Web Crypto PBKDF2 at 100,000 iterations.
const passwordIterations = 100_000;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const confirmationLifetimeMs = 30 * 60 * 1_000;
const abandonedSignupLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const installationLifetimeMs = 365 * 24 * 60 * 60 * 1_000;
const installationRefreshWindowMs = 364 * 24 * 60 * 60 * 1_000;
const maxAuthBodyBytes = 16 * 1_024;
const maxPasswordLength = 128;

export const currentTermsVersion = '2026-08-25';
export const currentPrivacyVersion = '2026-08-26';

type RateLimitPolicy = { limit: number; windowMs: number; blockMs: number };
const rateLimitPolicies = {
  signup: { ip: { limit: 10, windowMs: 60 * 60_000, blockMs: 60 * 60_000 }, account: { limit: 3, windowMs: 60 * 60_000, blockMs: 60 * 60_000 } },
  confirm: { ip: { limit: 30, windowMs: 15 * 60_000, blockMs: 60 * 60_000 }, account: { limit: 6, windowMs: 15 * 60_000, blockMs: 30 * 60_000 } },
  signin: { ip: { limit: 30, windowMs: 15 * 60_000, blockMs: 60 * 60_000 }, account: { limit: 10, windowMs: 15 * 60_000, blockMs: 30 * 60_000 } },
} as const;

export interface AuthEnvironment {
  DB: D1Database;
  AUTH_SESSION_SECRET: string;
  AUTH_DEV_MODE?: string;
  RESEND_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
}

export type VerificationDelivery = 'development' | 'email';

type AuthUserRow = {
  user_id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  verified_at: string | null;
  confirmation_hash: string | null;
  confirmation_expires_at: string | null;
};

type SignupConsent = {
  ageAttested: true;
  termsVersion: typeof currentTermsVersion;
  privacyVersion: typeof currentPrivacyVersion;
};

class AuthRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many authentication attempts. Try again later.');
    this.name = 'AuthRateLimitError';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function sessionSecret(env: AuthEnvironment): string {
  if (!env.AUTH_SESSION_SECRET || env.AUTH_SESSION_SECRET.length < 32) throw new Error('Authentication is not configured');
  return env.AUTH_SESSION_SECRET;
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: passwordIterations }, key, 256);
  return base64Url(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Email is required');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) throw new Error('Enter a valid email address');
  return email;
}

function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > maxPasswordLength || !/[a-z]/u.test(value) || !/[A-Z]/u.test(value) || !/\d/u.test(value)) {
    throw new Error(`Password must be 12 to ${maxPasswordLength} characters with upper-case, lower-case, and numeric characters`);
  }
  return value;
}

function signInPassword(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > maxPasswordLength) throw new Error('Password is required');
  return value;
}

async function sendConfirmation(email: string, code: string, env: AuthEnvironment): Promise<void> {
  if (env.AUTH_DEV_MODE === 'true') return;
  if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL) throw new Error('Email verification is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [email],
      subject: 'Verify your Ntern email',
      text: `Your Ntern verification code is ${code}. It expires in 30 minutes.`,
    }),
  });
  if (!response.ok) throw new Error('Could not send the verification email');
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxAuthBodyBytes) throw new Error('Request body is too large');
  if (!request.body) throw new Error('Request body must be valid JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxAuthBodyBytes) {
      await reader.cancel();
      throw new Error('Request body is too large');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function rateLimitKey(env: AuthEnvironment, scope: string, subject: string): Promise<string> {
  return sha256(`${sessionSecret(env)}:rate-limit:${scope}:${subject}`);
}

export async function consumeAuthRateLimit(
  env: AuthEnvironment,
  scope: string,
  subject: string,
  policy: RateLimitPolicy,
  nowMs = Date.now(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const key = await rateLimitKey(env, scope, subject);
  const resetBefore = nowMs - policy.windowMs;
  await env.DB.prepare(`
    INSERT INTO auth_rate_limits (key, window_started_at, attempts, blocked_until)
    VALUES (?, ?, 0, NULL) ON CONFLICT(key) DO NOTHING
  `).bind(key, nowMs).run();
  await env.DB.prepare(`
    UPDATE auth_rate_limits SET
      blocked_until = CASE
        WHEN blocked_until IS NOT NULL AND blocked_until > ? THEN blocked_until
        WHEN window_started_at <= ? THEN NULL
        WHEN attempts + 1 > ? THEN ?
        ELSE NULL
      END,
      attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
      window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END
    WHERE key = ?
  `).bind(nowMs, resetBefore, policy.limit, nowMs + policy.blockMs, resetBefore, resetBefore, nowMs, key).run();
  const row = await env.DB.prepare('SELECT attempts, blocked_until FROM auth_rate_limits WHERE key = ?')
    .bind(key).first<{ attempts: number; blocked_until: number | null }>();
  const blockedUntil = row?.blocked_until ?? 0;
  return {
    allowed: row !== null && row.attempts <= policy.limit && blockedUntil <= nowMs,
    retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - nowMs) / 1_000)),
  };
}

async function enforceAuthRateLimits(
  request: Request,
  email: string,
  operation: keyof typeof rateLimitPolicies,
  env: AuthEnvironment,
): Promise<void> {
  const policy = rateLimitPolicies[operation];
  const subjects: Array<{ scope: string; value: string; policy: RateLimitPolicy }> = [];
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  if (ip) subjects.push({ scope: `${operation}:ip`, value: ip, policy: policy.ip });
  subjects.push({ scope: `${operation}:account`, value: email, policy: policy.account });
  for (const subject of subjects) {
    const result = await consumeAuthRateLimit(env, subject.scope, subject.value, subject.policy);
    if (!result.allowed) throw new AuthRateLimitError(result.retryAfterSeconds);
  }
}

export async function signUp(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  const password = requirePassword(input.password);
  if (input.ageAttested !== true) throw new Error('Confirm that you are at least 18 years old');
  if (input.termsVersion !== currentTermsVersion || input.privacyVersion !== currentPrivacyVersion) {
    throw new Error('Review and accept the current Terms and Privacy Policy');
  }
  const consent: SignupConsent = {
    ageAttested: true,
    termsVersion: currentTermsVersion,
    privacyVersion: currentPrivacyVersion,
  };
  await enforceAuthRateLimits(request, email, 'signup', env);
  const timestamp = new Date();
  const salt = randomToken(16);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const confirmationHash = await sha256(`${sessionSecret(env)}:${code}`);
  const existing = await env.DB.prepare('SELECT user_id, verified_at, confirmation_expires_at FROM auth_users WHERE email = ?').bind(email).first<{ user_id: string; verified_at: string | null; confirmation_expires_at: string | null }>();
  if (existing?.verified_at) return json(409, { message: 'An account already exists for this email' });
  if (existing?.confirmation_expires_at && Date.parse(existing.confirmation_expires_at) > timestamp.getTime()) {
    return json(409, { message: 'A verification code was already sent. Wait for it to expire before creating the account again.' });
  }
  const userId = existing?.user_id ?? crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO auth_users (
      user_id, email, password_hash, password_salt, confirmation_hash, confirmation_expires_at,
      created_at, updated_at, age_attested_at, terms_version, terms_accepted_at, privacy_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt,
      confirmation_hash = excluded.confirmation_hash, confirmation_expires_at = excluded.confirmation_expires_at,
      updated_at = excluded.updated_at, age_attested_at = excluded.age_attested_at,
      terms_version = excluded.terms_version, terms_accepted_at = excluded.terms_accepted_at,
      privacy_version = excluded.privacy_version
  `).bind(
    userId,
    email,
    await passwordHash(password, salt),
    salt,
    confirmationHash,
    new Date(timestamp.getTime() + confirmationLifetimeMs).toISOString(),
    timestamp.toISOString(),
    timestamp.toISOString(),
    timestamp.toISOString(),
    consent.termsVersion,
    timestamp.toISOString(),
    consent.privacyVersion,
  ).run();
  try {
    await sendConfirmation(email, code, env);
  } catch (error) {
    // Let the user retry immediately after a provider failure, but do not clear
    // a newer confirmation written by a concurrent signup attempt.
    await env.DB.prepare(`
      UPDATE auth_users SET confirmation_hash = NULL, confirmation_expires_at = NULL, updated_at = ?
      WHERE user_id = ? AND verified_at IS NULL AND confirmation_hash = ?
    `).bind(new Date().toISOString(), userId, confirmationHash).run();
    throw error;
  }
  const development = env.AUTH_DEV_MODE === 'true';
  return json(201, {
    delivery: development ? 'development' : 'email',
    ...(development ? { confirmationCode: code } : {}),
  });
}

function installationTokenHash(token: string, env: AuthEnvironment): Promise<string> {
  return sha256(`${sessionSecret(env)}:installation:${token}`);
}

export async function createInstallation(env: AuthEnvironment): Promise<{ token: string; userId: string }> {
  const token = randomToken();
  const userId = `installation:${crypto.randomUUID()}`;
  const now = new Date();
  const timestamp = now.toISOString();
  const expiresAt = Math.floor((now.getTime() + installationLifetimeMs) / 1_000);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, session_id, expires_at)
      VALUES (?, 'INSTALLATION', 'installation', ?, ?, ?)
    `).bind(userId, JSON.stringify({ userId, createdAt: timestamp }), await installationTokenHash(token, env), expiresAt),
    env.DB.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      VALUES (?, 'PREFERENCES', 'preferences', ?)
    `).bind(userId, JSON.stringify({
      userId,
      filter: {},
      alertsEnabled: false,
      onboardingComplete: true,
      updatedAt: timestamp,
    })),
  ]);
  return { token, userId };
}

export async function authenticatedInstallation(request: Request, env: AuthEnvironment): Promise<string | undefined> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  if (!token) return undefined;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM user_items WHERE kind = 'installation' AND session_id = ?")
    .bind(await installationTokenHash(token, env)).first<{ user_id: string; expires_at: number | null }>();
  if (row && row.expires_at !== null && row.expires_at * 1_000 <= now) return undefined;
  if (row && (row.expires_at === null || row.expires_at * 1_000 < now + installationRefreshWindowMs)) {
    await env.DB.prepare("UPDATE user_items SET expires_at = ? WHERE user_id = ? AND kind = 'installation'")
      .bind(Math.floor((now + installationLifetimeMs) / 1_000), row.user_id).run();
  }
  return row?.user_id;
}

export async function confirmEmail(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  if (typeof input.code !== 'string') throw new Error('Verification code is required');
  await enforceAuthRateLimits(request, email, 'confirm', env);
  if (!/^\d{6}$/u.test(input.code.trim())) return json(400, { message: 'Verification code is invalid or expired' });
  const user = await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first<AuthUserRow>();
  const submitted = await sha256(`${sessionSecret(env)}:${input.code.trim()}`);
  if (!user?.confirmation_hash || !user.confirmation_expires_at || Date.parse(user.confirmation_expires_at) <= Date.now() || !constantTimeEqual(user.confirmation_hash, submitted)) {
    return json(400, { message: 'Verification code is invalid or expired' });
  }
  const timestamp = new Date().toISOString();
  await env.DB.prepare('UPDATE auth_users SET verified_at = ?, confirmation_hash = NULL, confirmation_expires_at = NULL, updated_at = ? WHERE user_id = ?').bind(timestamp, timestamp, user.user_id).run();
  return new Response(null, { status: 204 });
}

export async function signIn(request: Request, env: AuthEnvironment): Promise<Response> {
  const input = await body(request);
  const email = normalizeEmail(input.email);
  const password = signInPassword(input.password);
  await enforceAuthRateLimits(request, email, 'signin', env);
  const user = await env.DB.prepare('SELECT * FROM auth_users WHERE email = ?').bind(email).first<AuthUserRow>();
  const candidate = user ? await passwordHash(password, user.password_salt) : await passwordHash(password, randomToken(16));
  if (!user || !constantTimeEqual(user.password_hash, candidate)) return json(401, { message: 'Email or password is incorrect' });
  if (!user.verified_at) return json(403, { message: 'Verify your email before signing in' });
  const token = randomToken();
  const timestamp = new Date();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(`${sessionSecret(env)}:${token}`), user.user_id, new Date(timestamp.getTime() + sessionLifetimeMs).toISOString(), timestamp.toISOString()).run();
  return json(200, { token, expiresAt: new Date(timestamp.getTime() + sessionLifetimeMs).toISOString() });
}

export async function signOut(request: Request, env: AuthEnvironment): Promise<Response> {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length);
    if (token) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
        .bind(await sha256(`${sessionSecret(env)}:${token}`)).run();
    }
  }
  // Signing out is idempotent and does not reveal whether a token was valid.
  return new Response(null, { status: 204 });
}

export async function authenticatedUser(request: Request, env: AuthEnvironment): Promise<string | undefined> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const hash = await sha256(`${sessionSecret(env)}:${authorization.slice('Bearer '.length)}`);
  const session = await env.DB.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').bind(hash, new Date().toISOString()).first<{ user_id: string }>();
  return session?.user_id;
}

export async function deleteAuthUser(userId: string, env: AuthEnvironment): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_users WHERE user_id = ?').bind(userId).run();
}

export async function cleanupExpiredAuth(env: AuthEnvironment, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  const rateLimitCutoff = now.getTime() - 7 * 24 * 60 * 60_000;
  const abandonedSignupCutoff = new Date(now.getTime() - abandonedSignupLifetimeMs).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(timestamp),
    env.DB.prepare('DELETE FROM auth_users WHERE verified_at IS NULL AND updated_at <= ?').bind(abandonedSignupCutoff),
    env.DB.prepare('UPDATE auth_users SET confirmation_hash = NULL, confirmation_expires_at = NULL WHERE verified_at IS NULL AND confirmation_expires_at <= ?').bind(timestamp),
    env.DB.prepare('DELETE FROM auth_rate_limits WHERE window_started_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?)').bind(rateLimitCutoff, now.getTime()),
  ]);
}

export async function handleAuthRequest(request: Request, env: AuthEnvironment): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'POST' && path === '/auth/signup') return await signUp(request, env);
    if (request.method === 'POST' && path === '/auth/confirm') return await confirmEmail(request, env);
    if (request.method === 'POST' && path === '/auth/signin') return await signIn(request, env);
    if (request.method === 'POST' && path === '/auth/signout') return await signOut(request, env);
    return undefined;
  } catch (error) {
    if (error instanceof AuthRateLimitError) {
      const response = json(429, { message: error.message });
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
      return response;
    }
    return json(400, { message: error instanceof Error ? error.message : 'Invalid request' });
  }
}
