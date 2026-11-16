import { z } from "zod";
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const BillingPlanSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/), name: z.string().min(1).max(100),
  projects: limit, monthlyRuns: limit, monthlyHostedMinutes: limit, storageBytes: limit,
  retentionDays: z.number().int().min(1).max(3650),
  priceLabel: z.string().max(100).optional(), checkoutEnabled: z.boolean().default(false),
}).strict();
export type BillingPlan = z.infer<typeof BillingPlanSchema>;
export const DEFAULT_PLAN: BillingPlan = { id: "local", name: "Self-hosted", projects: null, monthlyRuns: null, monthlyHostedMinutes: null, storageBytes: null, retentionDays: 30, checkoutEnabled: false };
export const SubscriptionEventSchema = z.object({
  id: z.string().min(1).max(200), orgId: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  planId: z.string().max(50), status: z.enum(["active", "trialing", "past_due", "cancelled"]),
  periodStart: z.string().datetime(), periodEnd: z.string().datetime(),
}).strict().refine((v) => Date.parse(v.periodEnd) > Date.parse(v.periodStart), "Period end must follow start");
