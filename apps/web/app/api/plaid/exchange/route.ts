import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { plaidExchangeSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const requestSchema = z.object({ publicToken: z.string().min(4) });

function mapError(error: unknown): NextResponse {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const payload = (error as { payload?: unknown })?.payload as { error?: { code?: string; message?: string; traceId?: string } } | undefined;
  const code = payload?.error?.code ?? "PLAID_EXCHANGE_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "Plaid exchange failed");
  const traceId = payload?.error?.traceId;
  if (process.env.NODE_ENV !== "test") {
    console.error("[/api/plaid/exchange] proxy error", { status, code, message, traceId });
  }
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function POST(request: NextRequest) {
  const headerToken = request.headers.get("authorization")?.trim();
  let cookieToken;
  try {
    cookieToken = cookies().get("sp_token")?.value?.trim();
  } catch {
    cookieToken = undefined;
  }
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
  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;
    const payload = await request.json();
    const body = requestSchema.parse(payload);
    const result = await ledgerFetch<unknown>("/plaid/exchange", {
      method: "POST",
      headers: { authorization },
      body: JSON.stringify(body),
      baseUrlOverride,
    });
    const response = plaidExchangeSchema.parse(result);
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: error.message } }, { status: 400 });
    }
    return mapError(error);
  }
}
