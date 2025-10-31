import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ledgerFetch } from "@/src/lib/api-client";
import { transactionsListSchema } from "@/src/lib/schemas";
import { resolveLedgerBaseOverride } from "@/src/lib/ledger-routing";

const querySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}(-\d{2})?$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}(-\d{2})?$/)
      .optional(),
    accountId: z.string().uuid().optional(),
    page: z
      .string()
      .regex(/^\d+$/)
      .transform((v) => parseInt(v, 10))
      .optional(),
    pageSize: z
      .string()
      .regex(/^\d+$/)
      .transform((v) => Math.min(100, Math.max(1, parseInt(v, 10))))
      .optional(),
  });

export async function GET(request: NextRequest) {
  const headerToken = request.headers.get("authorization")?.trim();
  const cookieToken = request.cookies.get("sp_token")?.value?.trim();
  const rawAuthorization =
    headerToken?.startsWith("Bearer ")
      ? headerToken
      : headerToken
        ? `Bearer ${headerToken}`
        : cookieToken
          ? `Bearer ${cookieToken}`
          : null;

  const { baseUrlOverride, errorResponse } = resolveLedgerBaseOverride(request);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(request.url);
  const normalizePart = (value: string | null) => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/\//g, "-");
  };
  const query = querySchema.parse({
    month: normalizePart(searchParams.get("month")),
    from: normalizePart(searchParams.get("from")),
    to: normalizePart(searchParams.get("to")),
    accountId: searchParams.get("accountId") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  const endpoint = new URL("/transactions", "http://localhost");
  if (query.month) endpoint.searchParams.set("month", query.month.slice(0, 7));
  const normalizedFrom = query.from ? query.from.slice(0, 7) : undefined;
  const normalizedTo = query.to ? query.to.slice(0, 7) : undefined;
  if (normalizedFrom) endpoint.searchParams.set("from", normalizedFrom);
  if (normalizedTo) endpoint.searchParams.set("to", normalizedTo);
  if (query.accountId) endpoint.searchParams.set("accountId", query.accountId);

  const result = await ledgerFetch<unknown>(endpoint.pathname + endpoint.search, {
    method: "GET",
    headers: rawAuthorization ? { authorization: rawAuthorization } : undefined,
    baseUrlOverride,
  });
  const body = transactionsListSchema.parse(result);
  const includeDailyNet = Boolean(query.month);
  const aggregates = (() => {
    if (!Array.isArray(body.transactions) || body.transactions.length === 0) {
      return {
        incomeTotal: 0,
        expenseTotal: 0,
        netTotal: 0,
        monthNet: {},
        dayNet: includeDailyNet ? {} : undefined,
        categoryTotals: {},
        count: 0,
      };
    }
    const monthNet = new Map<string, number>();
    const categoryTotals = new Map<string, number>();
    const dayNet = includeDailyNet ? new Map<string, number>() : undefined;
    let incomeTotal = 0;
    let expenseTotal = 0;
    for (const tx of body.transactions) {
      const occurred = new Date(tx.occurredAt);
      if (!Number.isNaN(occurred.getTime())) {
        const label = `${occurred.getUTCFullYear()}-${String(occurred.getUTCMonth() + 1).padStart(2, "0")}`;
        monthNet.set(label, (monthNet.get(label) ?? 0) + tx.amount);
        if (dayNet) {
          const dayLabel = `${label}-${String(occurred.getUTCDate()).padStart(2, "0")}`;
          dayNet.set(dayLabel, (dayNet.get(dayLabel) ?? 0) + tx.amount);
        }
      }
      // Only include expenses (negative amounts) in categoryTotals for spending mix chart
      if (tx.amount < 0) {
        const category = tx.category;
        categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + tx.amount);
      }
      if (tx.amount > 0) incomeTotal += tx.amount;
      if (tx.amount < 0) expenseTotal += tx.amount;
    }
    const netTotal = Number((incomeTotal + expenseTotal).toFixed(2));
    return {
      incomeTotal: Number(incomeTotal.toFixed(2)),
      expenseTotal: Number(expenseTotal.toFixed(2)),
      netTotal,
      monthNet: Object.fromEntries(monthNet),
      dayNet: dayNet ? Object.fromEntries(dayNet) : undefined,
      categoryTotals: Object.fromEntries(categoryTotals),
      count: body.transactions.length,
    };
  })();
  const page = query.page ?? 0;
  const size = query.pageSize ?? 15;
  const start = page * size;
  const end = start + size;
  const paged = { ...body, transactions: body.transactions.slice(start, end), aggregates };
  return NextResponse.json(paged);
}
