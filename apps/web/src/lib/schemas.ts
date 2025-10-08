import { z } from "zod";

export const plaidLinkTokenSchema = z.object({
  linkToken: z.string(),
  expiration: z.string().datetime(),
  requestId: z.string(),
});

export const plaidExchangeSchema = z.object({
  itemId: z.string(),
  status: z.literal("SUCCESS"),
  requestId: z.string().nullable().optional(),
});

export const transactionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  merchantName: z.string(),
  amount: z.number(),
  currency: z.string().length(3),
  occurredAt: z.string().datetime(),
  authorizedAt: z.string().datetime(),
  pending: z.boolean(),
  category: z.string(),
  description: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  anomalyScore: z
    .object({
      method: z.enum(["Z_SCORE", "IQR"]),
      deltaAmount: z.number(),
      budgetImpactPercent: z.number(),
      commentary: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const transactionsListSchema = z.object({
  month: z.string(),
  transactions: z.array(transactionSchema),
  traceId: z.string().nullable().optional(),
});

export const analyticsSummarySchema = z.object({
  month: z.string(),
  totals: z.object({
    income: z.number(),
    expense: z.number(),
    net: z.number(),
  }),
  byCategory: z.array(
    z.object({
      category: z.string(),
      amount: z.number(),
      percentage: z.number(),
    }),
  ),
  topMerchants: z.array(
    z.object({
      merchant: z.string(),
      amount: z.number(),
      transactionCount: z.number(),
    }),
  ),
  anomalies: z.array(
    z.object({
      transactionId: z.string(),
      method: z.enum(["Z_SCORE", "IQR"]),
      amount: z.number(),
      deltaAmount: z.number(),
      budgetImpactPercent: z.number(),
      occurredAt: z.string().datetime(),
      merchantName: z.string(),
      commentary: z.string().nullable().optional(),
    }),
  ),
  aiHighlight: z.object({
    title: z.string(),
    summary: z.string(),
    sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
    recommendations: z.array(z.string()),
  }),
  traceId: z.string().nullable().optional(),
});

export const transactionsSyncSchema = z.object({
  status: z.enum(["STARTED", "COMPLETED"]),
  syncedCount: z.number(),
  pendingCount: z.number(),
  traceId: z.string().nullable().optional(),
});

// Chat schemas
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["USER", "ASSISTANT"]),
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const chatResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(chatMessageSchema),
  traceId: z.string().nullable().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
