import { describe, beforeEach, it, expect, vi } from "vitest";
import { createRagRouter } from "../rag-router";
import type { RagSearchResponse, RagAggregateResponse, RagSummariesResponse } from "../ragClient";

vi.mock("../ragClient", () => ({
  ragSummaries: vi.fn(),
  ragSearch: vi.fn(),
  ragAggregate: vi.fn(),
}));

const ragClientModule = await import("../ragClient");
const ragSummaries = ragClientModule.ragSummaries as ReturnType<typeof vi.fn>;
const ragSearch = ragClientModule.ragSearch as ReturnType<typeof vi.fn>;
const ragAggregate = ragClientModule.ragAggregate as ReturnType<typeof vi.fn>;

const mockSummary: RagSummariesResponse = {
  month: "2025-09",
  totals: { income: 10000, expense: -5000, net: 5000 },
  categories: [],
  merchants: [],
  traceId: "trace",
};

describe("rag-router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ragSummaries.mockResolvedValue(mockSummary);
  });

  it("deduplicates search rows across follow-ups", async () => {
    const searchResponse: RagSearchResponse = {
      rowsCsv: "t1,250915,m1,460,eo",
      dict: { merchants: { m1: "Starbucks" }, categories: { eo: "EatingOut" } },
      stats: { count: 1, sum: 460, avg: 460 },
      traceId: "trace",
      chatId: "chat-1",
    };
    ragSearch.mockImplementationOnce(() => Promise.resolve({ data: searchResponse, chatId: "chat-1" }));
    ragSearch.mockImplementationOnce(() => Promise.resolve({ data: searchResponse, chatId: "chat-1" }));

    const router = createRagRouter({ defaultMonth: "2025-09" });
    const first = await router.run("show Starbucks", {});
    expect(first.search?.rowsCsv).toContain("t1");
    const second = await router.run("show Starbucks", {});
    expect(second.search?.rowsCsv).toBe("");
  });

  it("invokes aggregate when trend requested", async () => {
    const aggregateResponse: RagAggregateResponse = {
      granularity: "month",
      from: null,
      to: null,
      buckets: [],
      timeline: [{ bucket: "2025-09", count: 2, sum: -800 }],
      traceId: "agg-trace",
      chatId: "chat-agg",
    };
    ragSearch.mockImplementationOnce(() => Promise.resolve({
      data: {
        rowsCsv: "",
        dict: { merchants: {}, categories: {} },
        stats: { count: 0, sum: 0, avg: 0 },
        traceId: "trace",
        chatId: "chat-agg",
      },
      chatId: "chat-agg",
    }));
    ragAggregate.mockResolvedValue({ data: aggregateResponse, chatId: "chat-agg" });

    const router = createRagRouter({ defaultMonth: "2025-09" });
    const result = await router.run("show the spending trend", {});
    expect(result.aggregate?.timeline[0].bucket).toBe("2025-09");
    expect(ragAggregate).toHaveBeenCalledTimes(1);
  });
});
