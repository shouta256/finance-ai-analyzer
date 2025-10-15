import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const requestSchema = z.discriminatedUnion("grantType", [
  z.object({
    grantType: z.literal("authorization_code"),
    code: z.string().min(1, "code is required"),
    redirectUri: z.string().url("redirectUri must be a valid URL"),
    codeVerifier: z.string().optional(),
  }),
  z.object({
    grantType: z.literal("refresh_token"),
    refreshToken: z.string().min(1, "refreshToken is required"),
  }),
]);

function mapError(error: unknown): NextResponse {
  if (error instanceof NextResponse) return error;
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: error.issues.map((i) => i.message).join(", ") } },
      { status: 400 },
    );
  }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const payload = (error as { payload?: unknown })?.payload as {
    error?: { code?: string; message?: string; traceId?: string };
  } | undefined;
  const code = payload?.error?.code ?? "AUTH_TOKEN_EXCHANGE_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "Auth token exchange failed");
  const traceId = payload?.error?.traceId;
  if (process.env.NODE_ENV !== "test") {
    console.error("[/api/auth/token] proxy error", { status, code, message, traceId });
  }
  return NextResponse.json({ error: { code, message, traceId } }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const raw = await request.json();
    const body = requestSchema.parse(raw);

    const result = await ledgerFetch<unknown>("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      baseUrlOverride,
    });

    return NextResponse.json(result);
  } catch (error) {
    return mapError(error);
  }
}
