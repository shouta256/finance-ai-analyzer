import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { transactionsSyncSchema } from "@/src/lib/schemas";

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
  const cookieToken = request.cookies.get("sp_token")?.value?.trim();
  const value = headerToken?.startsWith("Bearer ")
    ? headerToken
    : headerToken
      ? `Bearer ${headerToken}`
      : cookieToken
        ? `Bearer ${cookieToken}`
        : null;
  return value ? { authorization: value } : {};
}

const requestSchema = z.object({
  cursor: z.string().optional(),
  forceFullSync: z.boolean().optional(),
  demoSeed: z.boolean().optional(),
  startMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(
  (value) => !(value.startMonth && value.startDate),
  { message: "Provide startMonth or startDate, not both" },
);

type SyncRequest = z.infer<typeof requestSchema>;

function normalizeSyncRequest(body: SyncRequest): Omit<SyncRequest, "startDate"> & { startMonth?: string } {
  const { startDate, startMonth, ...rest } = body;
  const resolvedMonth = startMonth ?? (startDate ? startDate.slice(0, 7) : undefined);
  return resolvedMonth ? { ...rest, startMonth: resolvedMonth } : rest;
}

export async function POST(request: NextRequest) {
  const headers = authHeaders(request);
  if (!headers.authorization) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } }, { status: 401 });
  }
  try {
    const rawBody = request.headers.get("content-length") === "0" || request.headers.get("content-length") === null
      ? undefined
      : requestSchema.parse(await request.json());
    const body = rawBody ? normalizeSyncRequest(rawBody) : undefined;
    const res = await fetch(buildUrl("/transactions/sync"), {
      method: "POST",
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      return NextResponse.json({ error: json.error ?? { code: "TRANSACTIONS_SYNC_FAILED", message: res.statusText } }, { status: res.status });
    }
    const response = transactionsSyncSchema.parse(json);
    return NextResponse.json(response, { status: res.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: error.message } }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Transactions sync failed";
    return NextResponse.json({ error: { code: "TRANSACTIONS_SYNC_FAILED", message } }, { status: 500 });
  }
}
