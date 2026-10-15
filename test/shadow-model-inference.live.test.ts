import { describe, expect, it } from 'vitest';
import { inferShadowExtraction, shadowModelDefaults } from '../cloudflare/shadow-model-inference.js';
import { anthropicShadowModelId } from '../cloudflare/anthropic-shadow-inference.js';
import { localShadowApiKey } from '../scripts/shadow-model-cli.js';
import { SHADOW_EXTRACTION_MODEL_ID, normalizeExactPostingDescription, shadowExtractionPrompt,
  shadowExtractionRepairPrompt, projectShadowExtractionToSupportedFields, validateShadowExtraction } from '../src/shadow-extraction.js';

const model = process.env.ANTHROPIC_LIVE === '1' ? anthropicShadowModelId : SHADOW_EXTRACTION_MODEL_ID;
describe.skipIf(process.env.ANTHROPIC_LIVE !== '1' && process.env.SHADOW_MODEL_LIVE !== '1')(`${model} live extraction contract`, () => {
  it('compiles the full production schema and returns source-supported fields', async () => {
    const key = localShadowApiKey(model);
    const input = normalizeExactPostingDescription('Software Engineering Intern',
      'Location: Austin, Texas, United States. This role is onsite. Compensation: USD 40 per hour.');
    const initial = await inferShadowExtraction(key, input, shadowExtractionPrompt(input), fetch, shadowModelDefaults(model));
    let validation = validateShadowExtraction(initial.response, input);
    if (!validation.accepted) {
      const fields = validation.fieldOutcomes.filter(field => !field.accepted).map(field => field.field);
      const repaired = await inferShadowExtraction(key, input, shadowExtractionRepairPrompt(input, fields), fetch, shadowModelDefaults(model));
      validation = validateShadowExtraction(repaired.response, input);
    }
    const accepted = projectShadowExtractionToSupportedFields(validation.accepted ?? initial.response, input).accepted;
    expect(accepted).toBeDefined();
    expect(accepted?.fields.compensation).toMatchObject({ status: 'present', value: [{ min: 40, max: 40, currency: 'USD', period: 'hour' }] });
    expect(accepted?.fields.locations.status).toBe('present');
    expect(accepted?.fields.workMode).toMatchObject({ status: 'present', value: 'onsite' });
    expect(initial.inputTokens).toBeGreaterThan(0);
    expect(initial.outputTokens).toBeGreaterThan(0);
  }, 100_000);
});
