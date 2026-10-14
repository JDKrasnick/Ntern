import { existsSync } from 'node:fs';
import { shadowModelApiKey } from '../cloudflare/shadow-model-inference.js';

/** Load local secrets without printing or copying them to evaluation reports. */
export function localShadowApiKey(model: string): string {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const key = shadowModelApiKey(process.env, model);
  if (!key) throw new Error(`${model.startsWith('claude-') ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY or OPENAI_KEY'} is required in the environment or gitignored .env`);
  return key;
}
