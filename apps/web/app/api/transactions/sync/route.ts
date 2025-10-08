import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsSyncSchema } from "@/src/lib/schemas";

const requestSchema = z.object({ cursor: z.string().optional(), forceFullSync: z.boolean().optional() });

export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  const body = request.headers.get("content-length") === "0" ? undefined : requestSchema.parse(await request.json());
  const result = await ledgerFetch<unknown>("/transactions/sync", { method: "POST", headers: { authorization }, body: body ? JSON.stringify(body) : undefined });
  const response = transactionsSyncSchema.parse(result);
  return NextResponse.json(response, { status: 202 });
}
