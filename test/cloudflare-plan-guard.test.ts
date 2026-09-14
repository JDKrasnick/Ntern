import { describe, expect, it } from 'vitest';
import { actionableChanges, validateCloudflarePlan } from '../scripts/cloudflare-plan-guard.js';

const plan = (resourceChanges: Array<{ address: string; actions: string[] }>) => ({
  resource_changes: resourceChanges.map(({ address, actions }) => ({ address, change: { actions } })),
});

describe('Cloudflare deployment plan guard', () => {
  it('accepts no-op plans and in-place Worker script updates', () => {
    expect(validateCloudflarePlan(plan([]))).toEqual([]);
    expect(validateCloudflarePlan(plan([
      { address: 'cloudflare_workers_script.application', actions: ['update'] },
      { address: 'cloudflare_workers_script.ingestion', actions: ['update'] },
      { address: 'cloudflare_queue.work["ashby"]', actions: ['no-op'] },
    ]))).toHaveLength(2);
  });

  it.each([
    ['creates', 'cloudflare_workers_script.ingestion', ['create']],
    ['replacements', 'cloudflare_workers_script.application', ['delete', 'create']],
    ['non-script updates', 'cloudflare_workers_cron_trigger.ingestion', ['update']],
  ])('rejects %s', (_label, address, actions) => {
    expect(() => validateCloudflarePlan(plan([{ address, actions }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('omits data reads from the actionable summary', () => {
    expect(actionableChanges(plan([{ address: 'data.cloudflare_zone.application', actions: ['read'] }]))).toEqual([]);
  });
});
