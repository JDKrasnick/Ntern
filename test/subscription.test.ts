import { describe, expect, it } from 'vitest';
import { effectiveResumeSubscriptionPlan, resumeSubscriptionPeriod } from '../src/subscription.js';

describe('resume subscription plans', () => {
  it('keeps expired or revoked entitlements on the free allowance', () => {
    expect(effectiveResumeSubscriptionPlan({ userId: 'u', tier: 'pro', status: 'expired', provider: 'apple', updatedAt: 'now' }).tier).toBe('free');
    expect(effectiveResumeSubscriptionPlan({ userId: 'u', tier: 'plus', status: 'revoked', provider: 'apple', updatedAt: 'now' }).tier).toBe('free');
  });

  it('accepts active and billing-grace paid entitlements', () => {
    expect(effectiveResumeSubscriptionPlan({ userId: 'u', tier: 'plus', status: 'active', provider: 'apple', updatedAt: 'now' }).tailoredDraftsPerMonth).toBe(25);
    expect(effectiveResumeSubscriptionPlan({ userId: 'u', tier: 'pro', status: 'grace-period', provider: 'apple', updatedAt: 'now' }).tailoredDraftsPerMonth).toBe(100);
  });

  it('uses UTC calendar months for quota periods', () => {
    expect(resumeSubscriptionPeriod('2026-10-01T00:30:00+01:00')).toBe('2026-09');
  });
});
