import type { NormalizedPostingInput } from '../src/shadow-extraction.js';
import type { ShadowInferenceResult } from './shadow-extraction.js';
import { shadowResponseSchema, type ShadowInferenceOptions } from './openai-shadow-inference.js';

export const anthropicShadowModelId = 'claude-haiku-5-5';
export const anthropicShadowOutputTokens = 8192;

// Claude's grammar compiler does not support minLength. Domain validation
// still enforces nonempty evidence and exact source quotes after inference.
function grammarSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(grammarSchema);
  if (value && typeof value === 'object') {
    // Use the canonical string-list form accepted by the domain validator.
    const variants = (value as { anyOf?: Array<{ type?: string }> }).anyOf;
    if (variants?.length === 2 && variants[0]?.type === 'string' && variants[1]?.type === 'array') return grammarSchema(variants[1]);
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'minLength').map(([key, child]) => [key, grammarSchema(child)]));
  }
  return value;
}

function claudeSchema() {
  const schema = grammarSchema(shadowResponseSchema) as { properties: { fields: { properties: Record<string, unknown> } }; $defs?: Record<string, unknown> };
  const fields = schema.properties.fields.properties;
  // Reuse the identical list-valued field grammar rather than compiling five
  // copies (locations, housing, timing, education, and eligibility).
  const textField = { ...fields.locations as Record<string, unknown> };
  delete textField.description;
  schema.$defs = { textField };
  for (const field of ['locations', 'housing', 'timing', 'education', 'eligibility']) {
    const description = (fields[field] as { description?: string }).description;
    fields[field] = { $ref: '#/$defs/textField', ...(description ? { description } : {}) };
  }
  return schema;
}

interface ClaudeMessage {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

/** One bounded call; no SDK retries, tools, caching, or provider fallback. */
export async function inferAnthropicShadowExtraction(
  apiKey: string,
  input: NormalizedPostingInput,
  prompt: { system: string; user: string },
  request: typeof fetch = fetch,
  options: ShadowInferenceOptions = {},
): Promise<ShadowInferenceResult> {
  if (!apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is unavailable');
  if (options.model && options.model !== anthropicShadowModelId) throw new Error('Unsupported Claude extraction model');
  if (options.reasoningEffort === 'minimal') throw new Error('Claude effort must be low, medium, or high');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: anthropicShadowModelId,
        max_tokens: options.maxOutputTokens ?? anthropicShadowOutputTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: options.reasoningEffort ?? 'medium', format: { type: 'json_schema', schema: claudeSchema() } },
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      }),
      signal: controller.signal,
    });
    // Never include upstream error bodies: they may echo request data.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Claude request failed with status ${response.status}`);
    }
    const cap = 200_000;
    if (Number(response.headers.get('content-length')) > cap) {
      await response.body?.cancel();
      throw new Error('Claude response is oversized');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Claude response body is missing');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) { await reader.cancel(); throw new Error('Claude response is oversized'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const message = JSON.parse(new TextDecoder().decode(bytes)) as ClaudeMessage;
    if (message.stop_reason !== 'end_turn') throw new Error(`Claude response did not finish (${message.stop_reason ?? 'missing stop reason'})`);
    const inputTokens = message.usage?.input_tokens;
    const outputTokens = message.usage?.output_tokens;
    if (!Number.isSafeInteger(inputTokens) || inputTokens! < 0 || !Number.isSafeInteger(outputTokens) || outputTokens! < 0
      || (message.usage?.cache_creation_input_tokens ?? 0) !== 0 || (message.usage?.cache_read_input_tokens ?? 0) !== 0) {
      throw new Error('Claude response usage is invalid');
    }
    const blocks = message.content?.filter(block => block.type === 'text');
    if (blocks?.length !== 1 || !blocks[0]?.text) throw new Error('Claude response text is incomplete');
    let parsed: unknown;
    try { parsed = JSON.parse(blocks[0].text); } catch { throw new Error('Claude response is not valid JSON'); }
    // Thinking is included in output_tokens. Long-context rates apply to the
    // entire request above 100k; normal posting artifacts are capped at 40KB.
    const multiplier = inputTokens! > 100_000 ? 5 : 1;
    void input;
    return { response: parsed, inputTokens: inputTokens!, outputTokens: outputTokens!,
      actualCostCents: Math.ceil((inputTokens! * 10 + outputTokens! * 50) * multiplier / 1_000_000) };
  } finally { clearTimeout(timeout); }
}
