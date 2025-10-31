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

const toNumericValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Number) {
    const unpacked = value.valueOf();
    return Number.isFinite(unpacked) ? unpacked : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toCurrencyValue = (value: unknown): number => {
  const numeric = toNumericValue(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(2));
};

const normalizeRecord = (record?: Record<string, unknown>): Record<string, number> => {
  if (!record) return {};
  return Object.entries(record)
    .map(([key, value]) => [key, toCurrencyValue(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce<Record<string, number>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
};

const normalizeSeries = (series?: Array<{ period?: string; net?: unknown }>): Array<{ period: string; net: number }> => {
  if (!Array.isArray(series)) return [];
  return series
    .map((entry) => ({
      period: typeof entry.period === "string" ? entry.period : "",
      net: toCurrencyValue(entry.net),
    }))
    .filter((entry) => entry.period)
    .sort((a, b) => a.period.localeCompare(b.period));
};

const TREND_GRANULARITIES = ["DAY", "WEEK", "MONTH", "QUARTER"] as const;
type TrendGranularity = (typeof TREND_GRANULARITIES)[number];

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const startOfUtcWeek = (date: Date): Date => {
  const base = startOfUtcDay(date);
  const day = base.getUTCDay(); // 0 (Sun) - 6 (Sat)
  const diff = (day + 6) % 7; // convert to Monday=0
  base.setUTCDate(base.getUTCDate() - diff);
  return base;
};

const formatUtcDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const determineTrendGranularity = (includeDailyNet: boolean, minDate: Date | null, maxDate: Date | null): TrendGranularity => {
  if (includeDailyNet) return "DAY";
  if (!minDate || !maxDate) return "MONTH";
  const spanMs = startOfUtcDay(maxDate).getTime() - startOfUtcDay(minDate).getTime();
  const spanDays = Math.max(1, Math.round(spanMs / (24 * 60 * 60 * 1000)) + 1);
  if (spanDays <= 120) return "WEEK";
  if (spanDays <= 730) return "MONTH";
  return "QUARTER";
};

const quarterKey = (date: Date): string => {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
};

const buildTrendSeries = (
  transactions: Array<{ occurredAt: string; amount: number }>,
  includeDailyNet: boolean,
): { series: Array<{ period: string; net: number }>; granularity: TrendGranularity } => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { series: [], granularity: includeDailyNet ? "DAY" : "MONTH" };
  }

  const points: Array<{ date: Date; amount: number }> = [];
  for (const tx of transactions) {
    const amount = typeof tx.amount === "number" && Number.isFinite(tx.amount) ? tx.amount : 0;
    const occurred = tx.occurredAt ? new Date(tx.occurredAt) : null;
    if (!occurred || Number.isNaN(occurred.getTime())) continue;
    points.push({ date: occurred, amount });
  }
  if (points.length === 0) {
    return { series: [], granularity: includeDailyNet ? "DAY" : "MONTH" };
  }

  points.sort((a, b) => a.date.getTime() - b.date.getTime());
  const granularity = determineTrendGranularity(includeDailyNet, points[0]?.date ?? null, points.at(-1)?.date ?? null);
  const buckets = new Map<string, number>();

  for (const point of points) {
    const baseDate = startOfUtcDay(point.date);
    let key: string;
    switch (granularity) {
      case "DAY":
        key = formatUtcDate(baseDate);
        break;
      case "WEEK":
        key = formatUtcDate(startOfUtcWeek(baseDate));
        break;
      case "MONTH":
        key = `${baseDate.getUTCFullYear()}-${String(baseDate.getUTCMonth() + 1).padStart(2, "0")}`;
        break;
      case "QUARTER":
        key = quarterKey(baseDate);
        break;
      default:
        key = formatUtcDate(baseDate);
    }
    buckets.set(key, (buckets.get(key) ?? 0) + point.amount);
  }

  const series = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, value]) => ({ period, net: toCurrencyValue(value) }));

  return { series, granularity };
};

function computeAggregatesFromTransactions(
  transactions: Array<{ occurredAt: string; amount: number; category?: string | null }>,
  includeDailyNet: boolean,
) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    const timeline = buildTrendSeries([], includeDailyNet);
    return {
      incomeTotal: 0,
      expenseTotal: 0,
      netTotal: 0,
      monthNet: {},
      dayNet: includeDailyNet ? {} : undefined,
      monthSeries: [] as Array<{ period: string; net: number }>,
      daySeries: includeDailyNet ? ([] as Array<{ period: string; net: number }>) : undefined,
      trendSeries: timeline.series,
      trendGranularity: timeline.granularity,
      categoryTotals: {},
      count: 0,
    };
  }

  const monthNet = new Map<string, number>();
  const dayNet = includeDailyNet ? new Map<string, number>() : undefined;
  const categoryTotals = new Map<string, number>();
  let incomeTotal = 0;
  let expenseTotal = 0;

  for (const tx of transactions) {
    const amount = typeof tx.amount === "number" && Number.isFinite(tx.amount) ? tx.amount : 0;
    const occurred = tx.occurredAt ? new Date(tx.occurredAt) : null;
    if (occurred && !Number.isNaN(occurred.getTime())) {
      const monthLabel = `${occurred.getUTCFullYear()}-${String(occurred.getUTCMonth() + 1).padStart(2, "0")}`;
      monthNet.set(monthLabel, (monthNet.get(monthLabel) ?? 0) + amount);
      if (dayNet) {
        const dayLabel = `${monthLabel}-${String(occurred.getUTCDate()).padStart(2, "0")}`;
        dayNet.set(dayLabel, (dayNet.get(dayLabel) ?? 0) + amount);
      }
    }

    if (amount > 0) {
      incomeTotal += amount;
    } else if (amount < 0) {
      expenseTotal += amount;
      const category = typeof tx.category === "string" && tx.category.trim().length > 0 ? tx.category : "Uncategorised";
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + amount);
    }
  }

  const monthEntries = Array.from(monthNet.entries()).sort(([a], [b]) => a.localeCompare(b));
  const monthSeries = monthEntries.map(([period, value]) => ({ period, net: toCurrencyValue(value) }));
  const normalizedMonthNet = Object.fromEntries(monthSeries.map(({ period, net }) => [period, net]));

  let normalizedDayNet: Record<string, number> | undefined;
  let daySeries: Array<{ period: string; net: number }> | undefined;
  if (dayNet) {
    const dayEntries = Array.from(dayNet.entries()).sort(([a], [b]) => a.localeCompare(b));
    daySeries = dayEntries.map(([period, value]) => ({ period, net: toCurrencyValue(value) }));
    normalizedDayNet = Object.fromEntries(daySeries.map(({ period, net }) => [period, net]));
  }

  const normalizedCategoryTotals = Object.fromEntries(
    Array.from(categoryTotals.entries())
      .map(([category, value]) => [category, toCurrencyValue(value)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const timeline = buildTrendSeries(transactions, includeDailyNet);

  return {
    incomeTotal: toCurrencyValue(incomeTotal),
    expenseTotal: toCurrencyValue(expenseTotal),
    netTotal: toCurrencyValue(incomeTotal + expenseTotal),
    monthNet: normalizedMonthNet,
    dayNet: normalizedDayNet,
    monthSeries,
    daySeries,
    trendSeries: timeline.series,
    trendGranularity: timeline.granularity,
    categoryTotals: normalizedCategoryTotals,
    count: transactions.length,
  };
}

function normalizeExistingAggregates(
  aggregates: Record<string, unknown>,
  includeDailyNet: boolean,
  fallbackCount: number,
) {
  let normalizedMonthNet = normalizeRecord(aggregates.monthNet as Record<string, unknown> | undefined);
  let monthSeries = normalizeSeries(aggregates.monthSeries as Array<{ period?: string; net?: unknown }> | undefined);
  if (monthSeries.length === 0 && Object.keys(normalizedMonthNet).length > 0) {
    monthSeries = Object.entries(normalizedMonthNet).map(([period, net]) => ({ period, net }));
  }
  if (monthSeries.length > 0 && Object.keys(normalizedMonthNet).length === 0) {
    normalizedMonthNet = Object.fromEntries(monthSeries.map(({ period, net }) => [period, net]));
  }

  let normalizedDayNet: Record<string, number> | undefined;
  let daySeries: Array<{ period: string; net: number }> | undefined;
  if (includeDailyNet) {
    daySeries = normalizeSeries(aggregates.daySeries as Array<{ period?: string; net?: unknown }> | undefined);
    if (daySeries.length === 0) {
      normalizedDayNet = normalizeRecord(aggregates.dayNet as Record<string, unknown> | undefined);
      if (Object.keys(normalizedDayNet).length > 0) {
        daySeries = Object.entries(normalizedDayNet).map(([period, net]) => ({ period, net }));
      } else {
        normalizedDayNet = {};
        daySeries = [];
      }
    } else {
      normalizedDayNet = Object.fromEntries(daySeries.map(({ period, net }) => [period, net]));
    }
  }

  let trendSeries = normalizeSeries(aggregates.trendSeries as Array<{ period?: string; net?: unknown }> | undefined);
  let trendGranularity = typeof aggregates.trendGranularity === "string" && TREND_GRANULARITIES.includes(aggregates.trendGranularity as TrendGranularity)
    ? (aggregates.trendGranularity as TrendGranularity)
    : undefined;

  return {
    incomeTotal: toCurrencyValue(aggregates.incomeTotal),
    expenseTotal: toCurrencyValue(aggregates.expenseTotal),
    netTotal: toCurrencyValue(aggregates.netTotal),
    monthNet: normalizedMonthNet,
    dayNet: includeDailyNet ? normalizedDayNet : undefined,
    monthSeries,
    daySeries: includeDailyNet ? daySeries : undefined,
    trendSeries,
    trendGranularity,
    categoryTotals: normalizeRecord(aggregates.categoryTotals as Record<string, unknown> | undefined),
    count: typeof aggregates.count === "number" ? aggregates.count : fallbackCount,
  };
}

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
  const transactions = Array.isArray(body.transactions) ? body.transactions : [];
  let aggregates;
  if (transactions.length === 0) {
    aggregates = {
      incomeTotal: 0,
      expenseTotal: 0,
      netTotal: 0,
      monthNet: {},
      dayNet: includeDailyNet ? {} : undefined,
      monthSeries: [] as Array<{ period: string; net: number }>,
      daySeries: includeDailyNet ? ([] as Array<{ period: string; net: number }>) : undefined,
      trendSeries: [] as Array<{ period: string; net: number }>,
      trendGranularity: includeDailyNet ? "DAY" : "MONTH",
      categoryTotals: {},
      count: 0,
    };
  } else {
    const existing = body.aggregates as Record<string, unknown> | undefined;
    const hasMonthData = existing && (
      (Array.isArray(existing.monthSeries) && existing.monthSeries.length > 0) ||
      (existing.monthNet && Object.keys(existing.monthNet).length > 0)
    );
    const missingDailyData = includeDailyNet && (!existing || (
      (!Array.isArray(existing.daySeries) || existing.daySeries.length === 0) &&
      (!existing.dayNet || Object.keys(existing.dayNet).length === 0)
    ));
    if (!existing || !hasMonthData || missingDailyData) {
      aggregates = computeAggregatesFromTransactions(transactions, includeDailyNet);
    } else {
      aggregates = normalizeExistingAggregates(existing, includeDailyNet, transactions.length);
    }
  }
  let trendSeries = aggregates.trendSeries ?? [];
  let trendGranularity = aggregates.trendGranularity;
  if (!trendSeries || trendSeries.length === 0 || !trendGranularity) {
    const timeline = buildTrendSeries(transactions, includeDailyNet);
    trendSeries = timeline.series;
    trendGranularity = timeline.granularity;
  }
  if (includeDailyNet) {
    if ((!trendSeries || trendSeries.length === 0) && Array.isArray(aggregates.daySeries) && aggregates.daySeries.length > 0) {
      trendSeries = aggregates.daySeries.map((entry) => ({
        period: entry.period,
        net: toCurrencyValue(entry.net),
      }));
      trendGranularity = "DAY";
    }
  } else {
    const monthSeriesFallback = Array.isArray(aggregates.monthSeries) ? aggregates.monthSeries.map((entry) => ({
      period: entry.period,
      net: toCurrencyValue(entry.net),
    })) : Object.entries(aggregates.monthNet ?? {}).map(([period, net]) => ({
      period,
      net: toCurrencyValue(net),
    })).sort(([a], [b]) => a.localeCompare(b)).map(([period, net]) => ({ period, net }));
    const shouldUseMonthFallback =
      (!trendSeries || trendSeries.length === 0) ||
      (trendGranularity === "DAY") ||
      (trendGranularity === "WEEK" && trendSeries.length <= 3);
    if (shouldUseMonthFallback && monthSeriesFallback.length > 0) {
      trendSeries = monthSeriesFallback;
      trendGranularity = "MONTH";
    }
  }
  aggregates = {
    ...aggregates,
    trendSeries,
    trendGranularity,
  };
  const page = query.page ?? 0;
  const size = query.pageSize ?? 15;
  const start = page * size;
  const end = start + size;
  const paged = { ...body, transactions: body.transactions.slice(start, end), aggregates };
  return NextResponse.json(paged);
}
