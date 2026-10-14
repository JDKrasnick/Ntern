import { describe, expect, it } from 'vitest';
import { inferShadowExtraction } from '../cloudflare/shadow-model-inference.js';
import { localShadowApiKey } from '../scripts/shadow-model-cli.js';
import { SHADOW_EXTRACTION_MODEL_ID, normalizeExactPostingDescription, shadowExtractionPrompt,
  shadowExtractionRepairPrompt, projectShadowExtractionToSupportedFields, validateShadowExtraction } from '../src/shadow-extraction.js';

describe.skipIf(process.env.ANTHROPIC_LIVE !== '1')('Haiku live extraction contract', () => {
  it('compiles the full production schema and returns source-supported fields', async () => {
    const key = localShadowApiKey(SHADOW_EXTRACTION_MODEL_ID);
    const input = normalizeExactPostingDescription('Software Engineering Intern',
      'Location: Austin, Texas, United States. This role is onsite. Compensation: USD 40 per hour.');
    const initial = await inferShadowExtraction(key, input, shadowExtractionPrompt(input));
    let validation = validateShadowExtraction(initial.response, input);
    if (!validation.accepted) {
      const fields = validation.fieldOutcomes.filter(field => !field.accepted).map(field => field.field);
      const repaired = await inferShadowExtraction(key, input, shadowExtractionRepairPrompt(input, fields));
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
