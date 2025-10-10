import { NextRequest, NextResponse } from "next/server";
import { ragSearchRequestSchema, ragSearchResponseSchema } from "@/src/lib/ragClient";
import { ledgerFetch } from "@/src/lib/api-client";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const chatId = request.headers.get("x-chat-id") ?? crypto.randomUUID();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_BODY", message: "Request body must be JSON" } }, { status: 400 });
  }
  const body = ragSearchRequestSchema.parse(payload);
  try {
    const result = await ledgerFetch<unknown>("/rag/search", {
      method: "POST",
      headers: {
        authorization,
        "x-chat-id": chatId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed = ragSearchResponseSchema.parse(result);
    return NextResponse.json(parsed, { headers: { "x-chat-id": parsed.chatId ?? chatId } });
  } catch (error) {
    const err = error as any;
    return NextResponse.json({
      error: {
        code: "RAG_SEARCH_FAILED",
        message: err?.message ?? "RAG search failed",
        status: err?.status ?? 500,
        traceId: err?.payload?.error?.traceId ?? undefined,
        backendPayload: err?.payload ?? undefined,
      },
    }, { status: 502 });
  }
}
