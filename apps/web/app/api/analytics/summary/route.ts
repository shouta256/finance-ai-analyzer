import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { analyticsSummarySchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const querySchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), generateAi: z.string().optional() });

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
  if (errorResponse) return errorResponse;
  const { searchParams } = new URL(request.url);
  // Normalize month: change 2025/08 into 2025-08 (slash to hyphen)
  const rawMonth = searchParams.get("month") ?? undefined;
  const normalizedMonth = rawMonth ? rawMonth.replace(/\//g, "-") : undefined;
  const query = querySchema.parse({ month: normalizedMonth, generateAi: searchParams.get("generateAi") ?? undefined });
  const url = new URL(`/analytics/summary`, "http://local-proxy");
  url.searchParams.set("month", query.month);
  if (query.generateAi) url.searchParams.set("generateAi", query.generateAi);
  try {
    const result = await ledgerFetch<unknown>(`${url.pathname}${url.search}`, { method: "GET", headers: { authorization }, baseUrlOverride });
    const body = analyticsSummarySchema.parse(result);
    return NextResponse.json(body);
  } catch (e) {
    const err = e as any;
    // Surface more backend error context to the frontend for debugging (non-sensitive)
    return NextResponse.json({
      error: {
        code: "ANALYTICS_FETCH_FAILED",
        message: err?.message || "Backend analytics fetch failed",
        status: err?.status ?? 500,
        traceId: err?.payload?.error?.traceId ?? undefined,
        backendPayload: err?.payload ?? undefined,
      }
    }, { status: 502 });
  }
}
