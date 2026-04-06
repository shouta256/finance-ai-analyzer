import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const pathSchema = z.object({ transactionId: z.string().uuid() });
const bodySchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    notes: z.string().max(255).optional(),
  })
  .refine((data) => data.category || data.notes, {
    message: "At least one field must be provided",
  });

export async function PATCH(request: NextRequest, { params }: { params: unknown }) {
  const headerToken = request.headers.get("authorization")?.trim();
  const cookieToken = request.cookies.get("sp_token")?.value?.trim();
  const authorization =
    headerToken?.startsWith("Bearer ")
      ? headerToken
      : headerToken
        ? `Bearer ${headerToken}`
        : cookieToken
          ? `Bearer ${cookieToken}`
          : null;
  if (!authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
  if (errorResponse) return errorResponse;
  const { transactionId } = pathSchema.parse(params);
  const payload = bodySchema.parse(await request.json());
  const result = await ledgerFetch<unknown>(`/transactions/${transactionId}`, {
    method: "PATCH",
    headers: {
      authorization,
    },
    body: JSON.stringify(payload),
    baseUrlOverride,
  });
  const response = transactionSchema.parse(result);
  return NextResponse.json(response);
}
