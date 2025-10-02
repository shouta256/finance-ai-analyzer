import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { plaidExchangeSchema } from "@/src/lib/schemas";

const requestSchema = z.object({ publicToken: z.string().min(4) });

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const payload = await request.json();
  const body = requestSchema.parse(payload);
  const result = await ledgerFetch<unknown>("/plaid/exchange", {
    method: "POST",
    headers: {
      authorization,
    },
    body: JSON.stringify(body),
  });
  const response = plaidExchangeSchema.parse(result);
  return NextResponse.json(response);
}
