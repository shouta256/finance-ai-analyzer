import { NextRequest, NextResponse } from "next/server";
import { ledgerFetch } from "@/src/lib/api-client";
import { ragSummariesResponseSchema } from "@/src/lib/ragClient";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");
  if (!month) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "month query param required" } }, { status: 400 });
  }
  try {
    const result = await ledgerFetch<unknown>(`/rag/summaries?month=${encodeURIComponent(month)}`, {
      method: "GET",
      headers: { authorization },
    });
    const parsed = ragSummariesResponseSchema.parse(result);
    return NextResponse.json(parsed);
  } catch (error) {
    const err = error as any;
    return NextResponse.json({
      error: {
        code: "RAG_SUMMARIES_FAILED",
        message: err?.message ?? "RAG summaries failed",
        status: err?.status ?? 500,
        traceId: err?.payload?.error?.traceId ?? undefined,
        backendPayload: err?.payload ?? undefined,
      },
    }, { status: 502 });
  }
}
