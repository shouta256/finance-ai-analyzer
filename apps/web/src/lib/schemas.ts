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

export const transactionsListSchema = z
  .object({
    period: z
      .object({
        month: z.string().nullable().optional(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    transactions: z.array(transactionSchema),
    traceId: z.string().nullable().optional(),
  })
  .extend({
    month: z.string().optional(),
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

// Transactions reset response
// OpenAPI components.schemas.TransactionsResetResponse
export const transactionsResetResponseSchema = z.object({
  status: z.literal("ACCEPTED"),
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

// RAG schemas
export const ragSearchResponseSchema = z.object({
  rowsCsv: z.string(),
  dict: z.object({
    merchants: z.record(z.string()),
    categories: z.record(z.string()),
  }),
  stats: z.object({
    count: z.number(),
    sum: z.number(),
    avg: z.number(),
  }),
  traceId: z.string().nullable().optional(),
  chatId: z.string(),
});

export const ragSummariesResponseSchema = z.object({
  month: z.string(),
  totals: z.object({
    income: z.number(),
    expense: z.number(),
    net: z.number(),
  }),
  categories: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      count: z.number(),
      sum: z.number(),
      avg: z.number(),
    }),
  ),
  merchants: z.array(
    z.object({
      merchantId: z.string(),
      label: z.string(),
      count: z.number(),
      sum: z.number(),
    }),
  ),
  traceId: z.string().nullable().optional(),
});

export const ragAggregateResponseSchema = z.object({
  granularity: z.enum(["category", "merchant", "month"]),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  buckets: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number(),
      sum: z.number(),
      avg: z.number(),
    }),
  ),
  timeline: z.array(
    z.object({
      bucket: z.string(),
      count: z.number(),
      sum: z.number(),
    }),
  ),
  traceId: z.string().nullable().optional(),
  chatId: z.string(),
});

export type RagSearchResponse = z.infer<typeof ragSearchResponseSchema>;
export type RagSummariesResponse = z.infer<typeof ragSummariesResponseSchema>;
export type RagAggregateResponse = z.infer<typeof ragAggregateResponseSchema>;
