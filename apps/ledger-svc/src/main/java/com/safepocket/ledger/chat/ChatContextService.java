package com.safepocket.ledger.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.rag.RagNotReadyException;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.rag.TransactionEmbeddingService;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ChatContextService {

    private static final Logger log = LoggerFactory.getLogger(ChatContextService.class);
    private static final Set<String> GREETING_PHRASES = Set.of(
            "hello", "hi", "hey", "good morning", "good afternoon", "good evening", "what can you do"
    );
    private static final Set<String> FINANCE_KEYWORDS = Set.of(
            "account", "accounts", "amount", "balance", "budget", "cash", "category", "categories", "coffee",
            "dining", "drink", "drinks", "expense", "expenses", "finance", "financial", "groceries", "income",
            "merchant", "merchants", "money", "net", "payment", "payments", "rent", "salary", "saving",
            "savings", "spend", "spent", "spending", "summary", "transaction", "transactions", "travel"
    );
    private static final List<String> SUMMARY_PATTERNS = List.of(
            "summary", "overview", "income", "expenses", "net", "budget", "safe to spend",
            "top spending", "top categories", "top merchants", "how much money do i have"
    );
    private static final List<String> TRANSACTION_PATTERNS = List.of(
            "how much did i spend on", "how much did i spend for", "how much have i spent on",
            "where did i spend", "which transactions", "show transactions", "list transactions",
            "what did i spend on", "merchant", "category"
    );
    private static final String ASSISTANT_SCOPE =
            "You can answer only about the user's own finances, transactions, income, expenses, merchants, categories, and monthly summaries.";

    private final RagService ragService;
    private final TransactionEmbeddingService transactionEmbeddingService;
    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<SummaryCacheKey, CachedSummary> summaryCache = new ConcurrentHashMap<>();
    private static final Duration SUMMARY_CACHE_TTL = Duration.ofMinutes(2);

    public ChatContextService(
            RagService ragService,
            TransactionEmbeddingService transactionEmbeddingService,
            ObjectMapper objectMapper
    ) {
        this.ragService = ragService;
        this.transactionEmbeddingService = transactionEmbeddingService;
        this.objectMapper = objectMapper;
    }

    /**
     * Build compact JSON context for the chat assistant.
     * Includes current-month summary and a small window of recent candidate transactions
     * relevant to the latest user message (via RAG search).
     */
    @Transactional(readOnly = true, propagation = Propagation.NOT_SUPPORTED)
    public ChatContextBundle buildContextBundle(UUID userId, UUID conversationId, String latestUserMessage) {
        try {
            QuestionIntent intent = classifyIntent(latestUserMessage);
            Map<String, Object> root = new HashMap<>();
            root.put("intent", intent.name());
            root.put("question", safeString(latestUserMessage));
            root.put("assistantScope", ASSISTANT_SCOPE);

            if (intent == QuestionIntent.OUT_OF_SCOPE || intent == QuestionIntent.GREETING) {
                root.put("capabilities", List.of(
                        "monthly summaries",
                        "spending by merchant or category",
                        "income and expense questions"
                ));
                return new ChatContextBundle(
                        objectMapper.writeValueAsString(root),
                        List.of(),
                        new RagService.Stats(0, 0, 0),
                        conversationId != null ? conversationId.toString() : null
                );
            }

            // Summary is useful for finance/account questions, but sources are only attached for lookup-style queries.
            var ym = YearMonth.now();
            var summaries = fetchSummariesWithCache(userId, ym);
            root.put("summary", buildSummaryPayload(summaries));

            if (intent != QuestionIntent.TRANSACTION_LOOKUP) {
                root.put("retrieved", emptyRetrievedPayload());
                return new ChatContextBundle(
                        objectMapper.writeValueAsString(root),
                        List.of(),
                        new RagService.Stats(0, 0, 0),
                        conversationId != null ? conversationId.toString() : null
                );
            }

            // Transaction lookup questions use targeted retrieval over recent history.
            LocalDate to = LocalDate.now();
            LocalDate from = to.minusDays(90);
            var searchReq = new RagService.SearchRequest(
                    safeString(latestUserMessage),
                    from,
                    to,
                    null,
                    null,
                    null,
                    80,
                    false
            );
            String chatId = conversationId != null ? conversationId.toString() : null;
            var search = ragService.search(searchReq, chatId);
            root.put("retrieved", buildRetrievedPayload(search));

            return new ChatContextBundle(
                    objectMapper.writeValueAsString(root),
                    search.references(),
                    search.stats(),
                    search.chatId()
            );
        } catch (JsonProcessingException e) {
            log.warn("ChatContextService: JSON build failed: {}", e.toString());
            return ChatContextBundle.empty();
        } catch (Exception e) {
            log.warn("ChatContextService: context build failed: {}", e.toString());
            return ChatContextBundle.empty();
        }
    }

    public String buildContext(UUID userId, UUID conversationId, String latestUserMessage) {
        return buildContextBundle(userId, conversationId, latestUserMessage).contextJson();
    }

    @Transactional(readOnly = true, propagation = Propagation.NOT_SUPPORTED)
    public void assertRagReady(UUID userId) {
        TransactionEmbeddingService.RagReadiness readiness = transactionEmbeddingService.readinessForUser(userId);
        if (!readiness.tableReady()) {
            throw RagNotReadyException.infrastructureMissing();
        }
        if (readiness.transactionCount() > 0 && readiness.embeddingCount() < readiness.transactionCount()) {
            throw RagNotReadyException.embeddingsMissing(readiness.transactionCount(), readiness.embeddingCount());
        }
    }

    private static String safeString(String s) {
        return s == null ? "" : s;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    private Map<String, Object> buildSummaryPayload(RagService.SummariesResponse summaries) {
        Map<String, Object> summary = new HashMap<>();
        summary.put("month", summaries.month());
        summary.put("totals", Map.of(
                "incomeCents", summaries.totals().income(),
                "expenseCents", summaries.totals().expense(),
                "netCents", summaries.totals().net()
        ));

        int topN = 5;
        List<Map<String, Object>> topCats = summaries.categories().stream().limit(topN)
                .map(c -> Map.<String, Object>of(
                        "code", c.code(),
                        "label", c.label(),
                        "count", c.count(),
                        "sumCents", c.sum(),
                        "avgCents", c.avg()
                )).toList();
        List<Map<String, Object>> topMerchants = summaries.merchants().stream().limit(topN)
                .map(m -> Map.<String, Object>of(
                        "merchantId", m.merchantId(),
                        "label", m.label(),
                        "count", m.count(),
                        "sumCents", m.sum()
                )).toList();
        summary.put("topCategories", topCats);
        summary.put("topMerchants", topMerchants);
        return summary;
    }

    private Map<String, Object> buildRetrievedPayload(RagService.SearchResponse search) {
        Map<String, Object> retrieved = new HashMap<>();
        retrieved.put("rowsCsv", nullToEmpty(search.rowsCsv()));
        retrieved.put("dict", search.dict());
        retrieved.put("stats", Map.of(
                "count", search.stats().count(),
                "sumCents", search.stats().sum(),
                "avgCents", search.stats().avg()
        ));
        retrieved.put("references", search.references().stream()
                .limit(8)
                .map(ref -> Map.<String, Object>of(
                        "txCode", ref.txCode(),
                        "occurredOn", ref.occurredOn().toString(),
                        "merchant", ref.merchant(),
                        "amountCents", ref.amountCents(),
                        "category", ref.category(),
                        "matchedTerms", ref.matchedTerms(),
                        "reasons", ref.reasons()
                ))
                .toList());
        return retrieved;
    }

    private Map<String, Object> emptyRetrievedPayload() {
        return Map.of(
                "rowsCsv", "",
                "dict", Map.of("merchants", Map.of(), "categories", Map.of()),
                "stats", Map.of("count", 0, "sumCents", 0, "avgCents", 0),
                "references", List.of()
        );
    }

    private QuestionIntent classifyIntent(String rawQuestion) {
        String normalized = normalizeText(rawQuestion);
        if (normalized.isBlank()) {
            return QuestionIntent.GREETING;
        }
        if (isGreeting(normalized)) {
            return QuestionIntent.GREETING;
        }
        if (isExplicitlyOutOfScope(normalized)) {
            return QuestionIntent.OUT_OF_SCOPE;
        }
        if (!containsFinanceSignal(normalized)) {
            return QuestionIntent.OUT_OF_SCOPE;
        }
        if (containsAnyPattern(normalized, TRANSACTION_PATTERNS)
                || normalized.contains(" spent on ")
                || normalized.contains(" spent for ")
                || normalized.contains(" spend on ")
                || normalized.contains(" spend for ")) {
            return QuestionIntent.TRANSACTION_LOOKUP;
        }
        if (containsAnyPattern(normalized, SUMMARY_PATTERNS)) {
            return QuestionIntent.SUMMARY_ONLY;
        }
        return QuestionIntent.SUMMARY_ONLY;
    }

    private boolean isGreeting(String normalized) {
        if (GREETING_PHRASES.contains(normalized)) {
            return true;
        }
        long wordCount = normalized.split(" ").length;
        return wordCount <= 4 && GREETING_PHRASES.stream().anyMatch(normalized::startsWith);
    }

    private boolean isExplicitlyOutOfScope(String normalized) {
        if (normalized.contains("elon musk")) {
            return true;
        }
        if (normalized.contains("compare me to")) {
            return true;
        }
        if (normalized.contains("compared to ") && !normalized.contains("last month") && !normalized.contains("previous month")) {
            return true;
        }
        return normalized.contains("how much do i weigh");
    }

    private boolean containsFinanceSignal(String normalized) {
        for (String keyword : FINANCE_KEYWORDS) {
            if (normalized.contains(keyword)) {
                return true;
            }
        }
        return normalized.contains("how much did i spend")
                || normalized.contains("how much have i spent")
                || normalized.contains("expenses")
                || normalized.contains("income");
    }

    private boolean containsAnyPattern(String normalized, List<String> patterns) {
        return patterns.stream().anyMatch(normalized::contains);
    }

    private String normalizeText(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        return text.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", " ")
                .trim()
                .replaceAll("\\s+", " ");
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

    private enum QuestionIntent {
        GREETING,
        SUMMARY_ONLY,
        TRANSACTION_LOOKUP,
        OUT_OF_SCOPE
    }

    public record ChatContextBundle(
            String contextJson,
            List<RagService.SearchReference> sources,
            RagService.Stats stats,
            String chatId
    ) {
        public static ChatContextBundle empty() {
            return new ChatContextBundle("", List.of(), new RagService.Stats(0, 0, 0), null);
        }
    }
}
