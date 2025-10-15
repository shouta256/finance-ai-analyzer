import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const authErrorBody = { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } } as const;

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
  const code = payload?.error?.code ?? "ACCOUNTS_PROXY_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "Accounts proxy failed");
  const traceId = payload?.error?.traceId;
  if (process.env.NODE_ENV !== "test") {
    console.error("[api/accounts] proxy error", { status, code, message, traceId });
  }
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function GET(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const result = await ledgerFetch<unknown>("/accounts", {
      method: "GET",
      headers: { authorization },
      baseUrlOverride,
    });
    return NextResponse.json(result);
  } catch (error) {
    return mapError(error);
  }
}
