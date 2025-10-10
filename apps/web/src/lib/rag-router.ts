import {
  RagAggregateRequest,
  RagAggregateResponse,
  RagSearchRequest,
  RagSearchResponse,
  RagSummariesResponse,
  ragAggregate,
  ragSearch,
  ragSummaries,
} from "./ragClient";

export interface RagRouterOptions {
  defaultMonth: string;
  searchDefaults?: Partial<RagSearchRequest>;
  aggregateDefaults?: Partial<RagAggregateRequest>;
}

export interface RagRouterResult {
  summaries: RagSummariesResponse;
  search?: RagSearchResponse;
  aggregate?: RagAggregateResponse;
  chatId?: string;
}

function needsSearch(query: string): boolean {
  const lowered = query.toLowerCase();
  return /(明細|見せ|detail|show|list|取引|transactions?)/i.test(lowered)
    || /(昨日|today|yesterday|先週|specific)/i.test(lowered)
    || /\d{1,2}\s*(日|th|st|nd|rd)/i.test(lowered)
    || lowered.includes("追加")
    || lowered.includes("more");
}

function needsAggregate(query: string): boolean {
  const lowered = query.toLowerCase();
  return /(平均|trend|推移|per category|by category| breakdown |比較|compare)/i.test(lowered);
}

function cleanseSearchResult(result: RagSearchResponse, seen: Set<string>) {
  if (!result.rowsCsv) {
    return result;
  }
  const lines = result.rowsCsv.split("\n").filter(Boolean);
  const kept: string[] = [];
  const usedMerchants = new Set<string>();
  const usedCategories = new Set<string>();
  let sum = 0;
  for (const line of lines) {
    const cells = line.split(",");
    if (cells.length < 5) continue;
    const txCode = cells[0];
    const merchantCode = cells[2];
    const amountCents = Number.parseInt(cells[3], 10) || 0;
    const categoryCode = cells[4];
    if (seen.has(txCode)) {
      continue;
    }
    seen.add(txCode);
    kept.push(line);
    sum += amountCents;
    usedMerchants.add(merchantCode);
    usedCategories.add(categoryCode);
  }
  if (kept.length === lines.length) {
    kept.forEach((line) => {
      const [, , merchantCode, , categoryCode] = line.split(",");
      usedMerchants.add(merchantCode);
      usedCategories.add(categoryCode);
    });
    return result;
  }
  const dictMerchants = Object.fromEntries(
    Object.entries(result.dict.merchants).filter(([code]) => usedMerchants.has(code)),
  );
  const dictCategories = Object.fromEntries(
    Object.entries(result.dict.categories).filter(([code]) => usedCategories.has(code)),
  );
  const count = kept.length;
  const avg = count > 0 ? Math.trunc(sum / count) : 0;
  return {
    ...result,
    rowsCsv: kept.join("\n"),
    dict: {
      merchants: dictMerchants,
      categories: dictCategories,
    },
    stats: {
      count,
      sum,
      avg,
    },
  } satisfies RagSearchResponse;
}

export function createRagRouter(options: RagRouterOptions) {
  const seenTxIds = new Set<string>();
  let chatId: string | undefined;

  async function run(query: string, overrides?: Partial<RagSearchRequest>): Promise<RagRouterResult> {
    const month = overrides?.from?.slice(0, 7) ?? options.defaultMonth;
    const summaries = await ragSummaries(month);
    const result: RagRouterResult = { summaries, chatId };

    const shouldSearch = needsSearch(query);
    const shouldAggregate = needsAggregate(query);

    if (shouldAggregate) {
      const granularity = /(merchant|店舗|店)/i.test(query)
        ? "merchant"
        : /(month|推移|月次|trend)/i.test(query)
          ? "month"
          : options.aggregateDefaults?.granularity ?? "category";
      const aggregateRequest: RagAggregateRequest = {
        ...options.aggregateDefaults,
        from: overrides?.from ?? options.aggregateDefaults?.from,
        to: overrides?.to ?? options.aggregateDefaults?.to,
        granularity,
        chatId,
      };
      const aggregateResult = await ragAggregate(aggregateRequest);
      chatId = aggregateResult.chatId ?? chatId;
      result.aggregate = aggregateResult.data;
      result.chatId = chatId;
    }

    if (shouldSearch) {
      const searchRequest: RagSearchRequest = {
        ...(options.searchDefaults ?? {}),
        ...overrides,
      };
      const response = await ragSearch(searchRequest, { chatId });
      chatId = response.chatId ?? chatId;
      const deduped = cleanseSearchResult(response.data, seenTxIds);
      result.search = deduped;
      result.chatId = chatId;
    } else {
      result.chatId = chatId;
    }

    return result;
  }

  return {
    run,
    get chatId() {
      return chatId;
    },
  };
}
