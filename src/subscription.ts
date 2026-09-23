export type ResumeSubscriptionTier = 'free' | 'plus' | 'pro';
export type ResumeSubscriptionStatus = 'active' | 'grace-period' | 'expired' | 'revoked';
export type ResumeSubscriptionProvider = 'apple' | 'manual';

export interface ResumeSubscription {
  userId: string;
  tier: ResumeSubscriptionTier;
  status: ResumeSubscriptionStatus;
  provider: ResumeSubscriptionProvider;
  providerSubscriptionId?: string;
  currentPeriodEndsAt?: string;
  updatedAt: string;
}

export interface ResumeSubscriptionPlan {
  tier: ResumeSubscriptionTier;
  name: string;
  priceUsdMonthly: number;
  tailoredDraftsPerMonth: number;
}

export interface ResumeSubscriptionSummary {
  tier: ResumeSubscriptionTier;
  status: ResumeSubscriptionStatus;
  plan: ResumeSubscriptionPlan;
  usage: { period: string; used: number; limit: number; remaining: number };
  plans: readonly ResumeSubscriptionPlan[];
}

export const RESUME_SUBSCRIPTION_PLANS: readonly ResumeSubscriptionPlan[] = [
  { tier: 'free', name: 'Free', priceUsdMonthly: 0, tailoredDraftsPerMonth: 2 },
  { tier: 'plus', name: 'Plus', priceUsdMonthly: 4.99, tailoredDraftsPerMonth: 25 },
  { tier: 'pro', name: 'Pro', priceUsdMonthly: 9.99, tailoredDraftsPerMonth: 100 },
] as const;

export function resumeSubscriptionPeriod(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid subscription timestamp is required');
  return date.toISOString().slice(0, 7);
}

export function effectiveResumeSubscriptionPlan(subscription?: ResumeSubscription): ResumeSubscriptionPlan {
  const paid = subscription && (subscription.status === 'active' || subscription.status === 'grace-period');
  const tier = paid ? subscription.tier : 'free';
  return RESUME_SUBSCRIPTION_PLANS.find((plan) => plan.tier === tier) ?? RESUME_SUBSCRIPTION_PLANS[0]!;
}

export function resumeSubscriptionSummary(subscription: ResumeSubscription | undefined, used: number, timestamp: string): ResumeSubscriptionSummary {
  const plan = effectiveResumeSubscriptionPlan(subscription);
  const normalizedUsed = Math.max(0, Math.floor(used));
  return {
    tier: plan.tier,
    status: plan.tier === 'free' ? 'active' : subscription!.status,
    plan,
    usage: {
      period: resumeSubscriptionPeriod(timestamp),
      used: normalizedUsed,
      limit: plan.tailoredDraftsPerMonth,
      remaining: Math.max(0, plan.tailoredDraftsPerMonth - normalizedUsed),
    },
    plans: RESUME_SUBSCRIPTION_PLANS,
  };
}
