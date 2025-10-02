import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { analyticsSummarySchema } from "@/src/lib/schemas";

const querySchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({ month: searchParams.get("month") });
  const result = await ledgerFetch<unknown>(`/analytics/summary?month=${query.month}`, {
    method: "GET",
    headers: {
      authorization,
    },
  });
  const body = analyticsSummarySchema.parse(result);
  return NextResponse.json(body);
}
