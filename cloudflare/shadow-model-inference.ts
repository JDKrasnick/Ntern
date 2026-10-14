import { SHADOW_EXTRACTION_MODEL_ID, type NormalizedPostingInput } from '../src/shadow-extraction.js';
import { inferAnthropicShadowExtraction, anthropicShadowModelId, anthropicShadowOutputTokens } from './anthropic-shadow-inference.js';
import { inferOpenAIShadowExtraction, shadowModelPricingCents, type ShadowInferenceOptions } from './openai-shadow-inference.js';

export function shadowModelDefaults(model = SHADOW_EXTRACTION_MODEL_ID): ShadowInferenceOptions {
  if (model !== anthropicShadowModelId && !shadowModelPricingCents[model]) throw new Error(`Unsupported extraction model: ${model}`);
  return model === anthropicShadowModelId
    ? { model, maxOutputTokens: anthropicShadowOutputTokens, reasoningEffort: 'medium' }
    : { model, maxOutputTokens: 1400, reasoningEffort: model.startsWith('gpt-5-') ? 'minimal' : 'medium' };
}

export function shadowModelApiKey(env: { ANTHROPIC_API_KEY?: string; OPENAI_KEY?: string; OPENAI_API_KEY?: string }, model = SHADOW_EXTRACTION_MODEL_ID): string | undefined {
  return (model === anthropicShadowModelId ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY || env.OPENAI_KEY)?.trim() || undefined;
}

export function inferShadowExtraction(apiKey: string, input: NormalizedPostingInput, prompt: { system: string; user: string },
  request: typeof fetch = fetch, options: ShadowInferenceOptions = shadowModelDefaults()) {
  const resolved = { ...shadowModelDefaults(options.model), ...options };
  const infer = resolved.model === anthropicShadowModelId ? inferAnthropicShadowExtraction : inferOpenAIShadowExtraction;
  return infer(apiKey, input, prompt, request, resolved);
}
