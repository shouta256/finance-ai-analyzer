import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { ragAggregateResponseSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const authErrorBody = { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } } as const;

const dateRegex = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD
const aggregateSchema = z.object({
  from: z.string().regex(dateRegex, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(dateRegex, "to must be YYYY-MM-DD").optional(),
  granularity: z.enum(["category", "merchant", "month"]),
});

function requireAuthorization(request: NextRequest): string | NextResponse {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json(authErrorBody, { status: 401 });
  }
  return authorization;
}

function mapError(error: unknown): NextResponse {
  if (error instanceof NextResponse) return error;
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: error.issues.map((i) => i.message).join(", ") } },
      { status: 400 },
    );
  }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const payload = (error as { payload?: unknown })?.payload as { error?: { code?: string; message?: string; traceId?: string } } | undefined;
  const code = payload?.error?.code ?? "RAG_PROXY_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "RAG proxy failed");
  const traceId = payload?.error?.traceId;
  if (process.env.NODE_ENV !== "test") console.error("[api/rag/aggregate] proxy error", { status, code, message, traceId });
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function POST(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const raw = await request.json();
    const body = aggregateSchema.parse(raw);
    const result = await ledgerFetch("/rag/aggregate", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      baseUrlOverride,
    });
    const response = ragAggregateResponseSchema.parse(result);
    return NextResponse.json(response);
  } catch (error) {
    return mapError(error);
  }
}
