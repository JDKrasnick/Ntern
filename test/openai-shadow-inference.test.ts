import { describe, expect, it, vi } from 'vitest';
import { inferOpenAIShadowExtraction } from '../cloudflare/openai-shadow-inference.js';
import { normalizeExactPostingDescription, shadowExtractionPrompt } from '../src/shadow-extraction.js';

const input = normalizeExactPostingDescription('Software Engineering Intern', 'Austin\n$50 - $60 per hour');
const extracted = {
  classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
  fields: {
    compensation: { value: [{ min: 50, max: 60, currency: 'USD', period: 'hour' }], status: 'present', evidence: ['$50 - $60 per hour'], qualifiers: [] },
    locations: { value: ['Austin'], status: 'present', evidence: ['Austin'], qualifiers: [] },
    workMode: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
  },
};

describe('OpenAI shadow inference', () => {
  it('uses the pinned 4o-mini snapshot in JSON mode and records conservative cost', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-4o-mini-2024-07-18',
        temperature: 0,
        response_format: { type: 'json_schema' },
      });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
      return Response.json({
        choices: [{ message: { content: JSON.stringify(extracted) } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500 },
      });
    });
    await expect(inferOpenAIShadowExtraction('test-key', input, shadowExtractionPrompt(input), request as typeof fetch))
      .resolves.toEqual({ response: extracted, inputTokens: 1_000, outputTokens: 500, actualCostCents: 1 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('fails closed on upstream errors, invalid JSON, and missing usage', async () => {
    const prompt = shadowExtractionPrompt(input);
    await expect(inferOpenAIShadowExtraction('test-key', input, prompt, async () => Response.json({ error: { message: 'rate limited' } }, { status: 429 })))
      .rejects.toThrow('status 429');
    await expect(inferOpenAIShadowExtraction('test-key', input, prompt, async () => Response.json({
      choices: [{ message: { content: 'not-json' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }))).rejects.toThrow('not valid JSON');
    await expect(inferOpenAIShadowExtraction('test-key', input, prompt, async () => Response.json({
      choices: [{ message: { content: '{}' } }],
    }))).rejects.toThrow('incomplete');
  });

  it('allows an evaluation to cap output and account for a pinned GPT-5 mini snapshot', async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-5-mini-2025-08-07', max_completion_tokens: 321, reasoning_effort: 'minimal' });
      expect(body).not.toHaveProperty('temperature');
      return Response.json({ choices: [{ message: { content: JSON.stringify(extracted) } }], usage: { prompt_tokens: 1_000, completion_tokens: 500 } });
    });
    await expect(inferOpenAIShadowExtraction('test-key', input, shadowExtractionPrompt(input), request as typeof fetch,
      { model: 'gpt-5-mini-2025-08-07', maxOutputTokens: 321, reasoningEffort: 'minimal' }))
      .resolves.toMatchObject({ actualCostCents: 1 });
  });
});
