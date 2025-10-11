import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { chatResponseSchema } from "@/src/lib/schemas";

const authErrorBody = { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } } as const;

const chatQuerySchema = z.object({
  conversationId: z.string().uuid().optional(),
});

const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1),
  truncateFromMessageId: z.string().uuid().optional(),
});

function requireAuthorization(request: NextRequest): string | NextResponse {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json(authErrorBody, { status: 401 });
  }
  return authorization;
}

export async function GET(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

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
  });
  const body = chatResponseSchema.parse(result);
  return NextResponse.json(body);
}

export async function POST(request: NextRequest) {
  const authorization = requireAuthorization(request);
  if (authorization instanceof NextResponse) return authorization;

  const body = chatRequestSchema.parse(await request.json());
  const result = await ledgerFetch("/ai/chat", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = chatResponseSchema.parse(result);
  return NextResponse.json(response);
}
