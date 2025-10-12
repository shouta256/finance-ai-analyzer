package com.safepocket.ledger.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.rag.RagService.AggregateResponse;
import com.safepocket.ledger.rag.RagService.SearchRequest;
import com.safepocket.ledger.rag.RagService.SearchResponse;
import com.safepocket.ledger.rag.RagService.SummariesResponse;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class ChatContextService {

    private static final Logger log = LoggerFactory.getLogger(ChatContextService.class);
    private static final Pattern EXPLICIT_MONTH_PATTERN = Pattern.compile("(20\\d{2})[-/](0[1-9]|1[0-2])");
    private static final int MAX_MONTHS = 6;
    private static final long CACHE_TTL_MILLIS = 5 * 60 * 1000L; // 5 minutes

    private final RagService ragService;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<CacheKey, CachedSummary> cache = new ConcurrentHashMap<>();

    public ChatContextService(RagService ragService, ObjectMapper objectMapper) {
        this.ragService = ragService;
        this.objectMapper = objectMapper;
    }

    public String buildContext(UUID userId, UUID conversationId, String latestUserMessage) {
        List<YearMonth> months = resolveRelevantMonths(latestUserMessage);
        List<Map<String, Object>> monthSummaries = new ArrayList<>();
        for (YearMonth month : months) {
            SummariesResponse summary = getCachedSummary(userId, month);
            if (summary != null) {
                monthSummaries.add(toSummaryMap(summary));
            }
        }
        if (monthSummaries.isEmpty()) {
            return "";
        }

        String chatId = conversationId != null ? conversationId.toString() : UUID.randomUUID().toString();
        YearMonth primaryMonth = months.isEmpty() ? YearMonth.now(ZoneOffset.UTC) : months.getFirst();

        Map<String, Object> context = new LinkedHashMap<>();
        context.put("generatedAt", Instant.now().toString());
        context.put("months", monthSummaries);

        LocalDate from = primaryMonth.atDay(1);
        LocalDate to = primaryMonth.atEndOfMonth();

        if (requiresAggregate(latestUserMessage)) {
            AggregateResponse aggregate = ragService.aggregateForUser(userId, new RagService.AggregateRequest(
                    from,
                    to,
                    inferGranularity(latestUserMessage),
                    chatId
            ));
            context.put("aggregate", toAggregateMap(aggregate));
        }

        if (requiresSearch(latestUserMessage)) {
            SearchResponse search = ragService.searchForUser(
                    userId,
                    new SearchRequest(
                            latestUserMessage,
                            from,
                            to,
                            List.of(),
                            null,
                            null,
                            null
                    ),
                    chatId
            );
            if (!search.rowsCsv().isBlank()) {
                context.put("transactionsCsv", search.rowsCsv());
                context.put("dictionary", search.dict());
                context.put("searchStats", Map.of(
                        "count", search.stats().count(),
                        "sum", search.stats().sum(),
                        "avg", search.stats().avg()
                ));
            }
        }

        try {
            return objectMapper.writeValueAsString(context);
        } catch (JsonProcessingException e) {
            log.warn("Failed to serialise chat context", e);
            return "";
        }
    }

    private SummariesResponse getCachedSummary(UUID userId, YearMonth month) {
        CacheKey key = new CacheKey(userId, month);
        CachedSummary cached = cache.get(key);
        long now = System.currentTimeMillis();
        if (cached != null && (now - cached.createdAt()) < CACHE_TTL_MILLIS) {
            return cached.summary();
        }
        try {
            SummariesResponse summary = ragService.summariesForUser(userId, month);
            cache.put(key, new CachedSummary(summary, now));
            return summary;
        } catch (Exception ex) {
            log.warn("Unable to load rag summaries for {} {}: {}", userId, month, ex.getMessage());
            return null;
        }
    }

    private boolean requiresSearch(String message) {
        if (message == null || message.isBlank()) {
            return false;
        }
        String normalized = message.toLowerCase();
        return normalized.matches(".*(detail|show|list|transaction|transactions?).*")
                || normalized.matches(".*(today|yesterday|last week|specific).*")
                || normalized.matches(".*\\b\\d{1,2}(th|st|nd|rd)\\b.*")
                || normalized.contains("more")
                || normalized.contains("add ");
    }

    private boolean requiresAggregate(String message) {
        if (message == null || message.isBlank()) {
            return false;
        }
        String normalized = message.toLowerCase();
        return normalized.matches(".*(average|trend|per category|by category|breakdown|compare|top|most|largest|highest|ranking|spend).*");
    }

    private String inferGranularity(String message) {
        if (message == null) {
            return "category";
        }
        String normalized = message.toLowerCase();
        if (normalized.matches(".*(merchant|store|shop).*")) {
            return "merchant";
        }
        if (normalized.matches(".*(month|trend).*")) {
            return "month";
        }
        return "category";
    }

    private List<YearMonth> resolveRelevantMonths(String message) {
        LinkedHashSet<YearMonth> months = new LinkedHashSet<>();
        YearMonth current = YearMonth.now(ZoneOffset.UTC);
        String normalized = message == null ? "" : message.toLowerCase();

        Matcher matcher = EXPLICIT_MONTH_PATTERN.matcher(normalized);
        while (matcher.find() && months.size() < MAX_MONTHS) {
            try {
                int year = Integer.parseInt(matcher.group(1));
                int month = Integer.parseInt(matcher.group(2));
                months.add(YearMonth.of(year, month));
            } catch (Exception ignored) {
            }
        }

        if (containsAny(normalized, "six month", "6 month", "last half", "past half year")) {
            addRecentMonths(months, current, 6);
        } else if (containsAny(normalized, "three month", "3 month", "quarter")) {
            addRecentMonths(months, current, 3);
        }

        if (containsAny(normalized, "last month", "previous month")) {
            months.add(current.minusMonths(1));
        }

        if (containsAny(normalized, "this month", "current month")) {
            months.add(current);
        }

        if (months.isEmpty()) {
            months.add(current);
        }

        return months.stream().limit(MAX_MONTHS).toList();
    }

    private void addRecentMonths(LinkedHashSet<YearMonth> target, YearMonth startInclusive, int count) {
        for (int i = 0; i < count && target.size() < MAX_MONTHS; i++) {
            target.add(startInclusive.minusMonths(i));
        }
    }

    private boolean containsAny(String text, String... keywords) {
        for (String keyword : keywords) {
            if (text.contains(keyword)) {
                return true;
            }
        }
        return false;
    }

    private Map<String, Object> toSummaryMap(SummariesResponse summary) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("month", summary.month());
        map.put("totals", Map.of(
                "income", summary.totals().income(),
                "expense", summary.totals().expense(),
                "net", summary.totals().net()
        ));
        map.put("topCategories", summary.categories().stream()
                .map(cat -> Map.of(
                        "code", cat.code(),
                        "count", cat.count(),
                        "sum", cat.sum(),
                        "avg", cat.avg()
                ))
                .toList());
        map.put("topMerchants", summary.merchants().stream()
                .map(merch -> Map.of(
                        "merchantId", merch.merchantId(),
                        "count", merch.count(),
                        "sum", merch.sum()
                ))
                .toList());
        return map;
    }

    private Map<String, Object> toAggregateMap(AggregateResponse response) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("granularity", response.granularity());
        map.put("from", response.from() != null ? response.from().toString() : null);
        map.put("to", response.to() != null ? response.to().toString() : null);
        map.put("buckets", response.buckets().stream()
                .map(bucket -> Map.of(
                        "key", bucket.key(),
                        "count", bucket.count(),
                        "sum", bucket.sum(),
                        "avg", bucket.avg()
                ))
                .toList());
        map.put("timeline", response.timeline().stream()
                .map(point -> Map.of(
                        "bucket", point.bucket(),
                        "count", point.count(),
                        "sum", point.sum()
                ))
                .toList());
        return map;
    }

    private record CacheKey(UUID userId, YearMonth month) {}

    private record CachedSummary(SummariesResponse summary, long createdAt) {}
}
