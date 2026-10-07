import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const responses = JSON.parse(readFileSync(process.env.DEV_PROFILE_TEST_RESPONSES, 'utf8'));
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/client/v4/accounts/review-account', '') + url.search;
  if (!(path in responses)) throw new Error(`Unexpected profile request: ${path}`);
  return globalThis.Response.json({ success: true, result: responses[path] });
};
