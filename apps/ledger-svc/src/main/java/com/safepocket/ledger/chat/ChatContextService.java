package com.safepocket.ledger.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.analytics.AnalyticsService;
import com.safepocket.ledger.model.AnalyticsSummary;
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

    private final AnalyticsService analyticsService;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<CacheKey, CachedSummary> cache = new ConcurrentHashMap<>();

    public ChatContextService(AnalyticsService analyticsService, ObjectMapper objectMapper) {
        this.analyticsService = analyticsService;
        this.objectMapper = objectMapper;
    }

    public String buildContext(UUID userId, String latestUserMessage) {
        List<YearMonth> months = resolveRelevantMonths(latestUserMessage);
        List<Map<String, Object>> monthSummaries = new ArrayList<>();
        for (YearMonth month : months) {
            AnalyticsSummary summary = getCachedSummary(userId, month);
            if (summary != null) {
                monthSummaries.add(toContextMap(summary));
            }
        }
        if (monthSummaries.isEmpty()) {
            return "";
        }
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("generatedAt", java.time.Instant.now().toString());
        context.put("months", monthSummaries);
        try {
            return objectMapper.writeValueAsString(context);
        } catch (JsonProcessingException e) {
            log.warn("Failed to serialise chat context", e);
            return "";
        }
    }

    private AnalyticsSummary getCachedSummary(UUID userId, YearMonth month) {
        CacheKey key = new CacheKey(userId, month);
        CachedSummary cached = cache.get(key);
        long now = System.currentTimeMillis();
        if (cached != null && (now - cached.createdAt()) < CACHE_TTL_MILLIS) {
            return cached.summary();
        }
        try {
            AnalyticsSummary summary = analyticsService.getSummaryForUser(userId, month, false);
            cache.put(key, new CachedSummary(summary, now));
            return summary;
        } catch (Exception ex) {
            log.warn("Unable to load analytics summary for {} {}: {}", userId, month, ex.getMessage());
            return null;
        }
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

        if (containsAny(normalized, "six month", "6 month", "last half", "半年", "半年前", "過去半年")) {
            addRecentMonths(months, current, 6);
        } else if (containsAny(normalized, "three month", "3 month", "quarter", "三か月", "三ヶ月", "3ヶ月")) {
            addRecentMonths(months, current, 3);
        }

        if (containsAny(normalized, "last month", "previous month", "先月")) {
            months.add(current.minusMonths(1));
        }

        if (containsAny(normalized, "this month", "今月", "current month")) {
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

    private Map<String, Object> toContextMap(AnalyticsSummary summary) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("month", summary.month().toString());
        map.put("totals", Map.of(
                "income", summary.totals().income(),
                "expense", summary.totals().expense(),
                "net", summary.totals().net()
        ));
        map.put("topCategories", summary.categories());
        map.put("topMerchants", summary.merchants());
        map.put("anomalies", summary.anomalies());
        return map;
    }

    private record CacheKey(UUID userId, YearMonth month) {}

    private record CachedSummary(AnalyticsSummary summary, long createdAt) {}
}
