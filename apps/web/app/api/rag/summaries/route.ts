import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { ragSummariesResponseSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const authErrorBody = { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } } as const;

const ymRegex = /^\d{4}-\d{2}$/; // YYYY-MM

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
  if (process.env.NODE_ENV !== "test") console.error("[api/rag/summaries] proxy error", { status, code, message, traceId });
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function GET(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month");
    if (!month || !ymRegex.test(month)) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "month must be YYYY-MM" } }, { status: 400 });
    }
    const endpoint = new URL("/rag/summaries", "http://localhost");
    endpoint.searchParams.set("month", month);
    const result = await ledgerFetch(endpoint.pathname + endpoint.search, {
      method: "GET",
      headers: { authorization },
      baseUrlOverride,
    });
    const body = ragSummariesResponseSchema.parse(result);
    return NextResponse.json(body);
  } catch (error) {
    return mapError(error);
  }
}
