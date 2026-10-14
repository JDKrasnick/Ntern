import { describe, expect, it, vi } from 'vitest';
import { inferAnthropicShadowExtraction } from '../cloudflare/anthropic-shadow-inference.js';
import { inferShadowExtraction, shadowModelApiKey, shadowModelDefaults } from '../cloudflare/shadow-model-inference.js';
import { normalizeExactPostingDescription, shadowExtractionPrompt, shadowExtractionRepairPrompt, validateShadowExtraction } from '../src/shadow-extraction.js';
import { shadowVerificationPrompt } from '../src/shadow-verification.js';

const input = normalizeExactPostingDescription('Engineering Intern', 'Work in Austin.');
const prompt = shadowExtractionPrompt(input);
const absent = { value: null, status: 'not-stated', evidence: [], qualifiers: [] };
const extraction = { classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
  fields: { compensation: absent, locations: absent, workMode: absent, housing: absent, timing: absent, education: absent, eligibility: absent } };
const message = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: JSON.stringify(extraction) }],
  usage: { input_tokens: 1000, output_tokens: 500 } };

describe('Claude shadow inference', () => {
  it('routes extraction, repair, and verification through the same bounded structured-output adapter', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(init?.headers).toMatchObject({ 'x-api-key': 'claude-test', 'anthropic-version': '2023-06-01' });
      expect(init?.headers).not.toHaveProperty('authorization');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 8192, thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema' } } });
      expect(body).not.toHaveProperty('temperature');
      expect(JSON.stringify(body.output_config.format.schema)).not.toContain('minLength');
      const schema = body.output_config.format.schema;
      expect(schema.$defs.textField).toHaveProperty('anyOf');
      for (const field of ['locations', 'housing', 'timing', 'education', 'eligibility']) {
        expect(schema.properties.fields.properties[field]).toMatchObject({ $ref: '#/$defs/textField', description: expect.any(String) });
      }
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(message);
    });
    const accepted = validateShadowExtraction(extraction, input).accepted!;
    for (const next of [prompt, shadowExtractionRepairPrompt(input, ['locations']), shadowVerificationPrompt(input, accepted)]) {
      const result = await inferShadowExtraction('claude-test', input, next, request, shadowModelDefaults('claude-haiku-5-5'));
      expect(result).toEqual({ response: extraction, inputTokens: 1000, outputTokens: 500, actualCostCents: 1 });
      expect(validateShadowExtraction(result.response, input).failures).toEqual([]);
    }
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('selects only the intended provider credential and never falls back', async () => {
    expect(shadowModelApiKey({ OPENAI_KEY: 'openai' }, 'claude-haiku-5-5')).toBeUndefined();
    expect(shadowModelApiKey({ ANTHROPIC_API_KEY: 'claude', OPENAI_KEY: 'openai' }, 'claude-haiku-5-5')).toBe('claude');
    expect(shadowModelApiKey({ ANTHROPIC_API_KEY: 'claude' }, 'gpt-6-luna')).toBeUndefined();
    const request = vi.fn();
    await expect(inferAnthropicShadowExtraction('', input, prompt, request)).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(request).not.toHaveBeenCalled();
    expect(() => shadowModelDefaults('unknown')).toThrow('Unsupported');
  });

  it.each(['max_tokens', 'refusal', 'tool_use', undefined])('rejects unfinished or refused responses: %s', async stop_reason => {
    await expect(inferAnthropicShadowExtraction('key', input, prompt, async () => Response.json({ ...message, stop_reason })))
      .rejects.toThrow('did not finish');
  });

  it.each([
    { ...message, usage: undefined },
    { ...message, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...message, content: [{ type: 'thinking' }] },
    { ...message, content: [{ type: 'text', text: 'bad-json' }] },
  ])('rejects malformed content or missing usage', async response => {
    await expect(inferAnthropicShadowExtraction('key', input, prompt, async () => Response.json(response))).rejects.toThrow();
  });

  it('does not echo provider errors or retry failed requests', async () => {
    const request = vi.fn(async () => Response.json({ error: { message: 'sensitive request' } }, { status: 429 }));
    await expect(inferAnthropicShadowExtraction('key', input, prompt, request)).rejects.toThrow(/^Claude request failed with status 429$/u);
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops reading an oversized chunked body without a declared content length', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200001)); }, cancel }));
    await expect(inferAnthropicShadowExtraction('key', input, prompt, async () => response)).rejects.toThrow('oversized');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the deadline active until a stalled body is consumed', async () => {
    vi.useFakeTimers();
    try {
      const pending = inferAnthropicShadowExtraction('key', input, prompt, async (_url, init) => new Response(new ReadableStream({
        start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); },
      })));
      const assertion = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(60001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('uses Luna token limits and prices when explicitly selected for comparison', async () => {
    const request = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 8192, reasoning_effort: 'medium' });
      expect(body).not.toHaveProperty('temperature');
      return Response.json({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 100000, completion_tokens: 10000 } });
    });
    expect((await inferShadowExtraction('openai', input, prompt, request, shadowModelDefaults('gpt-6-luna'))).actualCostCents).toBe(2);
  });
});
