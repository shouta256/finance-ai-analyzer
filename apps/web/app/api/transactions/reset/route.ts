import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsResetResponseSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const requestSchema = z.object({
  unlinkPlaid: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
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

  let body: z.infer<typeof requestSchema> | undefined;
  const hasBody = request.headers.get("content-length") !== null && request.headers.get("content-length") !== "0";
  if (hasBody) {
    body = requestSchema.parse(await request.json());
  }

  const headers: Record<string, string> = { authorization };
  if (body) {
    headers["content-type"] = "application/json";
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }

  const result = await ledgerFetch<unknown>("/transactions/reset", {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    baseUrlOverride,
  });

  const parsed = transactionsResetResponseSchema.parse(result);
  return NextResponse.json(parsed, { status: 202 });
}
