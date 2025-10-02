import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsListSchema } from "@/src/lib/schemas";

const querySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/),
  accountId: z.string().uuid().optional(),
});

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    month: searchParams.get("month"),
    accountId: searchParams.get("accountId") ?? undefined,
  });
  const endpoint = new URL("/transactions", "http://localhost");
  endpoint.searchParams.set("month", query.month);
  if (query.accountId) {
    endpoint.searchParams.set("accountId", query.accountId);
  }
  const result = await ledgerFetch<unknown>(endpoint.pathname + endpoint.search, {
    method: "GET",
    headers: {
      authorization,
    },
  });
  const body = transactionsListSchema.parse(result);
  return NextResponse.json(body);
}
