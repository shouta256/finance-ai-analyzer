package com.safepocket.ledger.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.rag.RagService;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class ChatContextService {

    private static final Logger log = LoggerFactory.getLogger(ChatContextService.class);

    private final RagService ragService;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<SummaryCacheKey, CachedSummary> summaryCache = new ConcurrentHashMap<>();
    private static final Duration SUMMARY_CACHE_TTL = Duration.ofMinutes(2);

    public ChatContextService(RagService ragService, ObjectMapper objectMapper) {
        this.ragService = ragService;
        this.objectMapper = objectMapper;
    }

    /**
     * Build compact JSON context for the chat assistant.
     * Includes current-month summary and a small window of recent candidate transactions
     * relevant to the latest user message (via RAG search).
     */
    public String buildContext(UUID userId, UUID conversationId, String latestUserMessage) {
        try {
            // 1) Monthly summary (for dashboard-aligned numbers)
            var ym = YearMonth.now();
            var summaries = fetchSummariesWithCache(userId, ym);

            // 2) Targeted retrieval for the chat turn
            // Use last 90 days by default to keep context concise
            LocalDate to = LocalDate.now();
            LocalDate from = to.minusDays(90);
            var searchReq = new RagService.SearchRequest(
                    safeString(latestUserMessage),
                    from,
                    to,
                    null,
                    null,
                    null,
                    80
            );
            String chatId = conversationId != null ? conversationId.toString() : null;
            var search = ragService.search(searchReq, chatId);

            // 3) Assemble compact JSON payload (avoid PII; RagService already masks labels)
            Map<String, Object> root = new HashMap<>();
            Map<String, Object> summary = new HashMap<>();
            summary.put("month", summaries.month());
            summary.put("totals", Map.of(
                    "income", summaries.totals().income(),
                    "expense", summaries.totals().expense(),
                    "net", summaries.totals().net()
            ));
            // Top-N to keep context small
            int TOP_N = 5;
            List<Map<String, Object>> topCats = summaries.categories().stream().limit(TOP_N)
                    .map(c -> Map.<String, Object>of(
                            "code", c.code(),
                            "label", c.label(),
                            "count", c.count(),
                            "sum", c.sum(),
                            "avg", c.avg()
                    )).toList();
            List<Map<String, Object>> topMerchants = summaries.merchants().stream().limit(TOP_N)
                    .map(m -> Map.<String, Object>of(
                            "merchantId", m.merchantId(),
                            "label", m.label(),
                            "count", m.count(),
                            "sum", m.sum()
                    )).toList();
            summary.put("topCategories", topCats);
            summary.put("topMerchants", topMerchants);

            Map<String, Object> retrieved = new HashMap<>();
            retrieved.put("rowsCsv", nullToEmpty(search.rowsCsv()));
            retrieved.put("dict", search.dict());
            retrieved.put("stats", Map.of(
                    "count", search.stats().count(),
                    "sum", search.stats().sum(),
                    "avg", search.stats().avg()
            ));

            root.put("summary", summary);
            root.put("retrieved", retrieved);

            return objectMapper.writeValueAsString(root);
        } catch (JsonProcessingException e) {
            log.warn("ChatContextService: JSON build failed: {}", e.toString());
            return ""; // fallback to empty context
        } catch (Exception e) {
            log.warn("ChatContextService: context build failed: {}", e.toString());
            return ""; // fallback to empty context
        }
    }

    private static String safeString(String s) {
        return s == null ? "" : s;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    private RagService.SummariesResponse fetchSummariesWithCache(UUID userId, YearMonth month) {
        Instant now = Instant.now();
        SummaryCacheKey key = new SummaryCacheKey(userId, month);
        CachedSummary cached = summaryCache.get(key);
        if (cached != null && cached.expiresAt().isAfter(now)) {
            return cached.value();
        }
        RagService.SummariesResponse fresh = ragService.summaries(month);
        summaryCache.put(key, new CachedSummary(fresh, now.plus(SUMMARY_CACHE_TTL)));
        evictExpiredSummaries(now);
        return fresh;
    }

    private void evictExpiredSummaries(Instant now) {
        summaryCache.entrySet().removeIf(entry -> entry.getValue().expiresAt().isBefore(now));
    }

    private record SummaryCacheKey(UUID userId, YearMonth month) {}

    private record CachedSummary(RagService.SummariesResponse value, Instant expiresAt) {}
}
