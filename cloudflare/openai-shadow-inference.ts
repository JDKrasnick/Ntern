import type { NormalizedPostingInput } from '../src/shadow-extraction.js';
import type { ShadowInferenceResult } from './shadow-extraction.js';

const endpoint = 'https://api.openai.com/v1/chat/completions';
const maxResponseBytes = 100_000;
const requestTimeoutMs = 45_000;
export const shadowDefaultModelId = 'gpt-4o-mini-2024-07-18';
export const shadowModelPricingCents: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini-2024-07-18': { input: 15, output: 60 },
  'gpt-5-mini-2025-08-07': { input: 25, output: 200 },
  'gpt-4o-2024-08-06': { input: 250, output: 1000 },
};

const evidence = { type: 'array', items: { type: 'string', minLength: 1 } } as const;
const qualifiers = { type: 'array', items: { type: 'string', minLength: 1 } } as const;

function fieldSchema(presentValue: Record<string, unknown>) { return {
  anyOf: [
    {
      type: 'object', additionalProperties: false, required: ['value', 'status', 'evidence', 'qualifiers'],
      properties: { value: presentValue, status: { type: 'string', enum: ['present'] }, evidence, qualifiers },
    },
    {
      type: 'object', additionalProperties: false, required: ['value', 'status', 'evidence', 'qualifiers'],
      properties: {
        value: { type: 'null' }, status: { type: 'string', enum: ['not-stated', 'conflicting', 'incomplete'] },
        evidence, qualifiers,
      },
    },
  ],
} as const; }

const strings = {
  anyOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
  ],
};

const workMode = { type: 'string', enum: ['remote', 'hybrid', 'onsite'] } as const;

const compensation = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['min', 'max', 'currency', 'period'],
    properties: {
      min: { type: 'number' }, max: { type: 'number' }, currency: { type: 'string' },
      period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'one-time', 'unknown'] },
    },
  },
};

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'fields'],
  properties: {
    classification: {
      type: 'object', additionalProperties: false, required: ['technical', 'earlyCareer', 'disciplines'],
      properties: {
        technical: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        earlyCareer: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        disciplines: { type: 'array', items: { type: 'string' } },
      },
    },
    fields: {
      type: 'object', additionalProperties: false,
      required: ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'],
      properties: {
        compensation: fieldSchema(compensation),
        locations: fieldSchema({ type: 'array', items: { type: 'string' } }),
        workMode: fieldSchema(workMode), housing: fieldSchema(strings), timing: fieldSchema(strings),
        education: fieldSchema(strings), eligibility: fieldSchema(strings),
      },
    },
  },
} as const;

interface OpenAIChatCompletion {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

export interface ShadowInferenceOptions {
  model?: string;
  pricing?: { inputCentsPerMillionTokens: number; outputCentsPerMillionTokens: number };
  maxOutputTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

function billedCents(inputTokens: number, outputTokens: number, pricing: NonNullable<ShadowInferenceOptions['pricing']>): number {
  return Math.ceil((inputTokens * pricing.inputCentsPerMillionTokens + outputTokens * pricing.outputCentsPerMillionTokens) / 1_000_000);
}

async function boundedJson(response: Response): Promise<OpenAIChatCompletion> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) throw new Error('OpenAI response is oversized');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes) throw new Error('OpenAI response is oversized');
  return JSON.parse(new TextDecoder().decode(bytes)) as OpenAIChatCompletion;
}

export async function inferOpenAIShadowExtraction(
  apiKey: string,
  input: NormalizedPostingInput,
  prompt: { system: string; user: string },
  request: typeof fetch = fetch,
  options: ShadowInferenceOptions = {},
): Promise<ShadowInferenceResult> {
  if (!apiKey.trim()) throw new Error('OpenAI API key is unavailable');
  const model = options.model ?? shadowDefaultModelId;
  const listed = shadowModelPricingCents[model] ?? shadowModelPricingCents[shadowDefaultModelId]!;
  const pricing = options.pricing ?? { inputCentsPerMillionTokens: listed.input, outputCentsPerMillionTokens: listed.output };
  const outputCap = options.maxOutputTokens ?? 2_500;
  // GPT-5 Chat Completions rejects the legacy cap name used by the pinned
  // GPT-4o-mini production snapshot. Preserve backwards compatibility while
  // allowing bounded evaluation runs on newer models.
  const outputLimit = model.startsWith('gpt-5-') ? { max_completion_tokens: outputCap } : { max_tokens: outputCap };
  const sampling = model.startsWith('gpt-5-') ? {} : { temperature: 0 };
  const reasoning = model.startsWith('gpt-5-') && options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  try {
    response = await request(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        ...sampling,
        ...reasoning,
        ...outputLimit,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'shadow_metadata_extraction', strict: true, schema: responseSchema },
        },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const completion = await boundedJson(response);
  if (!response.ok) {
    const detail = typeof completion.error?.message === 'string' ? `: ${completion.error.message.slice(0, 300)}` : '';
    throw new Error(`OpenAI request failed with status ${response.status}${detail}`);
  }
  const content = completion.choices?.[0]?.message?.content;
  const inputTokens = integer(completion.usage?.prompt_tokens);
  const outputTokens = integer(completion.usage?.completion_tokens);
  if (!content || inputTokens === undefined || outputTokens === undefined) {
    throw new Error(`OpenAI response is incomplete (content=${typeof content}, inputTokens=${inputTokens ?? 'missing'}, outputTokens=${outputTokens ?? 'missing'})`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('OpenAI response is not valid JSON'); }
  // The model only sees this bounded artifact and the versioned extraction
  // prompt. Preserve input in the signature to make that boundary explicit.
  void input;
  return { response: parsed, inputTokens, outputTokens, actualCostCents: billedCents(inputTokens, outputTokens, pricing) };
}
