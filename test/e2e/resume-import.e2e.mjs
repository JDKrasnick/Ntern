import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { zipSync } from 'fflate';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiWorkerName = 'intern-notifs-e2e-resume-api';
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';
const docxContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** A minimal DOCX whose document.xml the real extractor turns into one project
 * with two attached bullets. */
const resumeDocx = (() => {
  const paragraphs = ['Projects', 'Compiler Lab', '• Built a parser', '• Added type checking'];
  const xml = `<w:document><w:body>${paragraphs.map((text) => `<w:p><w:t>${text}</w:t></w:p>`).join('')}</w:body></w:document>`;
  const bytes = zipSync({ 'word/document.xml': Buffer.from(xml, 'utf8') });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
})();

let runtime;
let api;
let database;
let documents;

async function createWorkerConfig(name, bundleDirectory, bundleName, env) {
  return {
    config: {
      name,
      type: 'worker',
      compatibilityDate: localCompatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      manifest: {
        mainModule: bundleName,
        modulesRoot: bundleDirectory,
        modules: {
          [bundleName]: { type: 'esm', contents: await readFile(join(bundleDirectory, bundleName), 'utf8') },
        },
      },
      env,
    },
  };
}

async function applyMigrations(target) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await target.batch(splitSqlQuery(sql).map((statement) => target.prepare(statement)));
  }
}

before(async () => {
  runtime = new Miniflare({
    workers: [
      await createWorkerConfig(apiWorkerName, join(repositoryRoot, 'cloudflare/dist/api'), 'api-worker.js', {
        DEPLOYMENT_ROLE: { type: 'text', value: 'api' },
        IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: { type: 'text', value: 'false' },
        PUBLIC_API_URL: { type: 'text', value: 'https://api.example.test' },
        AUTH_DEV_MODE: { type: 'text', value: 'true' },
        AUTH_SESSION_SECRET: { type: 'text', value: 'e2e-auth-session-secret-at-least-32-characters' },
        RESUME_TUNER_ENABLED: { type: 'text', value: 'true' },
        DB: { type: 'd1', id: 'intern-notifs-e2e-resume' },
        DOCUMENTS: { type: 'r2', name: 'intern-notifs-e2e-resume-documents' },
      }),
    ],
  });
  await runtime.ready;
  database = await runtime.getD1Database('DB', apiWorkerName);
  documents = await runtime.getR2Bucket('DOCUMENTS', apiWorkerName);
  await applyMigrations(database);
  api = await runtime.getWorker(apiWorkerName);
});

after(async () => {
  await runtime?.dispose();
});

async function signIn() {
  const email = `resume-${randomUUID()}@example.test`;
  const password = 'Review-only password 175!';
  const signup = await api.fetch('https://api.example.test/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, ageAttested: true, termsVersion: '2026-08-25', privacyVersion: '2026-08-26' }),
  });
  assert.equal(signup.status, 201);
  const { confirmationCode } = await signup.json();
  const confirm = await api.fetch('https://api.example.test/auth/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: confirmationCode }),
  });
  assert.equal(confirm.status, 204);
  const signin = await api.fetch('https://api.example.test/auth/signin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(signin.status, 200);
  const { token } = await signin.json();
  const preferences = await api.fetch('https://api.example.test/me/preferences', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(preferences.status, 200);
  return { token, userId: (await preferences.json()).userId };
}

const authorized = (token, init = {}) => ({ ...init, headers: { "Content-Type": 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

async function seedDocument(userId, documentId = 'resume') {
  const objectKey = `private/${userId}/${documentId}`;
  await documents.put(objectKey, resumeDocx, { httpMetadata: { contentType: docxContentType } });
  await database.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, 'document', ?)")
    .bind(userId, `DOCUMENT#${documentId}`, JSON.stringify({ userId, documentId, fileName: 'resume.docx', contentType: docxContentType, objectKey, createdAt: new Date().toISOString() }))
    .run();
}

test('imports a real DOCX through the compiled API Worker and reconciles a re-import', async () => {
  const { token, userId } = await signIn();
  await seedDocument(userId);

  const first = await api.fetch('https://api.example.test/me/resume-bank/import', authorized(token, { method: 'POST', body: JSON.stringify({ documentId: 'resume' }) }));
  assert.equal(first.status, 201);
  const firstItems = (await first.json()).items;
  assert.deepEqual(firstItems.map((item) => item.content).sort(), ['Added type checking', 'Built a parser', 'Compiler Lab']);

  const second = await api.fetch('https://api.example.test/me/resume-bank/import', authorized(token, { method: 'POST', body: JSON.stringify({ documentId: 'resume' }) }));
  assert.equal(second.status, 201);
  const secondItems = (await second.json()).items;
  assert.deepEqual(secondItems.map((item) => item.bankItemId).sort(), firstItems.map((item) => item.bankItemId).sort());

  const bank = await api.fetch('https://api.example.test/me/resume-bank', authorized(token));
  assert.equal(bank.status, 200);
  assert.equal((await bank.json()).items.length, 3);
});

test('reports the résumé document cap through the compiled API Worker instead of a generic failure', async () => {
  const { token } = await signIn();
  for (let index = 0; index < 5; index += 1) {
    const created = await api.fetch('https://api.example.test/me/documents', authorized(token, { method: 'POST', body: JSON.stringify({ fileName: `resume-${index}.pdf`, contentType: 'application/pdf' }) }));
    assert.equal(created.status, 201);
  }
  const capped = await api.fetch('https://api.example.test/me/documents', authorized(token, { method: 'POST', body: JSON.stringify({ fileName: 'resume-6.pdf', contentType: 'application/pdf' }) }));
  assert.equal(capped.status, 409);
  assert.match((await capped.json()).message, /5 résumé documents/);
});

test('resolves a pasted description into a ready import through the compiled API Worker', async () => {
  const { token } = await signIn();
  const resolved = await api.fetch('https://api.example.test/me/resume-jobs/resolve', authorized(token, {
    method: 'POST', body: JSON.stringify({ url: 'https://careers.example.test/jobs/1', manualDescription: 'Build data pipelines in TypeScript with a small platform team.' }),
  }));
  assert.equal(resolved.status, 201);
  const imported = await resolved.json();
  assert.equal(imported.status, 'ready');
  assert.equal(imported.source, 'manual');

  const listed = await api.fetch('https://api.example.test/me/resume-imports', authorized(token));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).imports.length, 1);
});
