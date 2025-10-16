import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsListSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const querySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    accountId: z.string().uuid().optional(),
  })
  .refine((data) => data.month || data.from, { message: "Provide month or from" });

export async function GET(request: NextRequest) {
  const headerToken = request.headers.get("authorization")?.trim();
  const cookieToken = request.cookies.get("sp_token")?.value?.trim();
  const authorization =
    headerToken?.startsWith("Bearer ")
      ? headerToken
      : headerToken
        ? `Bearer ${headerToken}`
        : cookieToken
          ? `Bearer ${cookieToken}`
          : null;
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }

  const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(request.url);
  const query = querySchema.parse({
    month: searchParams.get("month") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    accountId: searchParams.get("accountId") ?? undefined,
  });

  const endpoint = new URL("/transactions", "http://localhost");
  if (query.month) endpoint.searchParams.set("month", query.month);
  if (query.from) endpoint.searchParams.set("from", query.from);
  if (query.to) endpoint.searchParams.set("to", query.to);
  if (query.accountId) endpoint.searchParams.set("accountId", query.accountId);

  const result = await ledgerFetch<unknown>(endpoint.pathname + endpoint.search, {
    method: "GET",
    headers: { authorization },
    baseUrlOverride,
  });
  const body = transactionsListSchema.parse(result);
  return NextResponse.json(body);
}
