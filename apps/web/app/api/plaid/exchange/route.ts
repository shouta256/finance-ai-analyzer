import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { plaidExchangeSchema } from "@/src/lib/schemas";

const BASE = process.env.LEDGER_SERVICE_URL?.replace(/\/+$/, "") || "";
const PFX = process.env.LEDGER_SERVICE_PATH_PREFIX?.replace(/^\/+|\/+$/g, "") || "";

function buildUrl(path: string): string {
  if (!BASE) throw new Error("LEDGER_SERVICE_URL is not configured");
  const prefix = PFX ? `/${PFX}` : "";
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}${prefix}${suffix}`;
}

function authHeaders(request: NextRequest): Record<string, string> {
  const headerToken = request.headers.get("authorization")?.trim();
  let cookieToken: string | undefined;
  try {
    cookieToken = cookies().get("sp_token")?.value?.trim();
  } catch {
    cookieToken = undefined;
  }
  const authorization = headerToken?.startsWith("Bearer ")
    ? headerToken
    : headerToken
      ? `Bearer ${headerToken}`
      : cookieToken
        ? `Bearer ${cookieToken}`
        : null;
  return authorization ? { authorization } : {};
}

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
  try {
    const payload = await request.json();
    const body = requestSchema.parse(payload);
    const res = await fetch(buildUrl("/plaid/exchange"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(request),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      return mapError({ status: res.status, payload: json, message: json?.error?.message || res.statusText });
    }
    const response = plaidExchangeSchema.parse(json);
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: error.message } }, { status: 400 });
    }
    return mapError(error);
  }
}
