import { NextResponse, type NextRequest } from "next/server";
import { ledgerFetch } from "@/src/lib/api-client";
import { plaidLinkTokenSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

function mapError(error: unknown): NextResponse {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const payload = (error as { payload?: unknown })?.payload as { error?: { code?: string; message?: string; traceId?: string } } | undefined;
  const code = payload?.error?.code ?? "PLAID_LINK_TOKEN_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "Plaid link token failed");
  const traceId = payload?.error?.traceId;
  if (process.env.NODE_ENV !== "test") {
    console.error("[/api/plaid/link-token] proxy error", { status, code, message, traceId });
  }
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;
    const result = await ledgerFetch<unknown>("/plaid/link-token", {
      method: "POST",
      headers: { authorization },
      baseUrlOverride,
    });
    const body = plaidLinkTokenSchema.parse(result);
    return NextResponse.json(body);
  } catch (error) {
    return mapError(error);
  }
}
