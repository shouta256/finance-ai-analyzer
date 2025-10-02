import { NextResponse, type NextRequest } from "next/server";
import { ledgerFetch } from "@/src/lib/api-client";
import { plaidLinkTokenSchema } from "@/src/lib/schemas";

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const result = await ledgerFetch<unknown>("/plaid/link-token", {
    method: "POST",
    headers: {
      authorization,
    },
  });
  const body = plaidLinkTokenSchema.parse(result);
  return NextResponse.json(body);
}
