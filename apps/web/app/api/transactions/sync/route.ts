import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsSyncSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const requestSchema = z.object({
  cursor: z.string().optional(),
  forceFullSync: z.boolean().optional(),
  demoSeed: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const header = request.headers.get("authorization")?.trim();
  const cookieToken = request.cookies.get("sp_token")?.value?.trim();
  const authorization = header?.startsWith("Bearer ") ? header : header ? `Bearer ${header}` : cookieToken ? `Bearer ${cookieToken}` : null;
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
  if (errorResponse) return errorResponse;
  const body = request.headers.get("content-length") === "0" || request.headers.get("content-length") === null
    ? undefined
    : requestSchema.parse(await request.json());
  const result = await ledgerFetch<unknown>("/transactions/sync", {
    method: "POST",
    headers: { authorization, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    baseUrlOverride,
  });
  const response = transactionsSyncSchema.parse(result);
  return NextResponse.json(response, { status: 202 });
}
