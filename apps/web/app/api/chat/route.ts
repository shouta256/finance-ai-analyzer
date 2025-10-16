import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { chatResponseSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const authErrorBody = { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } } as const;

const chatQuerySchema = z.object({
  conversationId: z.string().uuid().optional(),
});

const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1),
  truncateFromMessageId: z.string().uuid().optional(),
});

function normalizeBearer(value: string): string {
  return value.startsWith("Bearer ") ? value : `Bearer ${value}`;
}

function requireAuthorization(request: NextRequest): string | NextResponse {
  // Prefer header when present, else fall back to cookie (supports SSR & client fetch)
  const header = request.headers.get("authorization");
  if (header && header.trim()) {
    return normalizeBearer(header.trim());
  }
  const cookieToken = request.cookies.get("sp_token")?.value;
  if (cookieToken && cookieToken.trim()) {
    return normalizeBearer(cookieToken.trim());
  }
  return NextResponse.json(authErrorBody, { status: 401 });
}

function mapError(error: unknown): NextResponse {
  if (error instanceof NextResponse) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: error.issues.map((issue) => issue.message).join(", "),
        },
      },
      { status: 400 },
    );
  }

  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const payload = (error as { payload?: unknown })?.payload as { error?: { code?: string; message?: string; traceId?: string } } | undefined;
  const code = payload?.error?.code ?? "CHAT_PROXY_FAILED";
  const message = payload?.error?.message ?? (error instanceof Error ? error.message : "Chat proxy failed");
  const traceId = payload?.error?.traceId;

  if (process.env.NODE_ENV !== "test") {
    console.error("[api/chat] proxy error", { status, code, message, traceId });
  }

  return NextResponse.json(
    {
      error: {
        code,
        message,
        traceId,
      },
    },
    { status },
  );
}

export async function GET(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const { searchParams } = new URL(request.url);
    const query = chatQuerySchema.parse({
      conversationId: searchParams.get("conversationId") ?? undefined,
    });
    const endpoint = new URL("/ai/chat", "http://localhost");
    if (query.conversationId) {
      endpoint.searchParams.set("conversationId", query.conversationId);
    }
    const result = await ledgerFetch(endpoint.pathname + endpoint.search, {
      method: "GET",
      headers: { authorization },
      baseUrlOverride,
    });
    const body = chatResponseSchema.parse(result);
    return NextResponse.json(body);
  } catch (error) {
    return mapError(error);
  }
}

export async function POST(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  try {
    const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
    if (errorResponse) return errorResponse;

    const raw = await request.json();
    const body = chatRequestSchema.parse(raw);
    const result = await ledgerFetch("/ai/chat", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      baseUrlOverride,
    });
    const response = chatResponseSchema.parse(result);
    return NextResponse.json(response);
  } catch (error) {
    return mapError(error);
  }
}
