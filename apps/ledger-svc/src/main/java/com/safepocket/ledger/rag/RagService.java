package com.safepocket.ledger.rag;

import com.safepocket.ledger.analytics.AnalyticsService;
import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.security.RlsGuard;
import java.time.Clock;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RagService {

    private static final Set<String> QUERY_STOP_WORDS = Set.of(
            "about", "after", "before", "could", "from", "have", "last", "more",
            "much", "show", "tell", "than", "that", "this", "what", "when",
            "where", "which", "with", "your"
    );
    private static final Map<String, List<String>> QUERY_SYNONYMS = Map.of(
            "drink", List.of("coffee", "latte", "tea", "beverage"),
            "drinks", List.of("coffee", "latte", "tea", "beverage"),
            "coffee", List.of("latte", "cafe"),
            "latte", List.of("coffee"),
            "beverage", List.of("coffee", "tea"),
            "cafe", List.of("coffee", "latte")
    );

    private final AuthenticatedUserProvider authenticatedUserProvider;
    private final RlsGuard rlsGuard;
    private final RagRepository ragRepository;
    private final TxEmbeddingRepository txEmbeddingRepository;
    private final TransactionEmbeddingService transactionEmbeddingService;
    private final EmbeddingService embeddingService;
    private final ChatSessionDiffTracker diffTracker;
    private final RagAuditLogger auditLogger;
    private final SafepocketProperties properties;
    private final AnalyticsService analyticsService;
    private final Clock clock;

        @Autowired
        public RagService(
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            RagRepository ragRepository,
            TxEmbeddingRepository txEmbeddingRepository,
            TransactionEmbeddingService transactionEmbeddingService,
            EmbeddingService embeddingService,
            ChatSessionDiffTracker diffTracker,
            RagAuditLogger auditLogger,
            SafepocketProperties properties,
            AnalyticsService analyticsService
    ) {
        this(authenticatedUserProvider, rlsGuard, ragRepository, txEmbeddingRepository, transactionEmbeddingService, embeddingService,
                diffTracker, auditLogger, properties, analyticsService, Clock.systemUTC());
    }

    RagService(
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            RagRepository ragRepository,
            TxEmbeddingRepository txEmbeddingRepository,
            TransactionEmbeddingService transactionEmbeddingService,
            EmbeddingService embeddingService,
            ChatSessionDiffTracker diffTracker,
            RagAuditLogger auditLogger,
            SafepocketProperties properties,
            AnalyticsService analyticsService,
            Clock clock
    ) {
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
        this.ragRepository = ragRepository;
        this.txEmbeddingRepository = txEmbeddingRepository;
        this.transactionEmbeddingService = transactionEmbeddingService;
        this.embeddingService = embeddingService;
        this.diffTracker = diffTracker;
        this.auditLogger = auditLogger;
        this.properties = properties;
        this.analyticsService = analyticsService;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public SearchResponse search(SearchRequest request, String chatId) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        return searchForUser(userId, request, chatId);
    }

    public SearchResponse searchForUser(UUID userId, SearchRequest request, String chatId) {
        rlsGuard.setAppsecUser(userId);
        int limit = Math.min(
                Optional.ofNullable(request.topK()).orElse(properties.rag().maxRows()),
                100
        );
        float[] queryVector = Optional.ofNullable(request.q())
                .filter(s -> !s.isBlank())
                .map(embeddingService::embed)
                .orElse(null);
        List<String> queryTerms = expandQueryTerms(extractQueryTerms(request.q()));

        // When a query is present, widen the candidate pool so we can score by cosine similarity properly.
        int candidateLimit = (queryVector != null && queryVector.length > 0)
                ? Math.min(500, Math.max(limit * 10, properties.rag().maxRows() * 10))
                : limit;

        List<TxEmbeddingRepository.EmbeddingMatch> matches = txEmbeddingRepository.findNearest(
                userId,
                queryVector,
                request.from(),
                request.to(),
                request.categories(),
                request.amountMin(),
                request.amountMax(),
                candidateLimit
        );

        boolean requiresReindex = matches.isEmpty() || matches.stream().anyMatch(match -> match.embedding().length == 0);
        if (requiresReindex) {
            List<RagRepository.TransactionSlice> candidates = ragRepository.findTransactionsForEmbedding(
                    userId,
                    request.from(),
                    request.to(),
                    request.categories(),
                    request.amountMin(),
                    request.amountMax(),
                    Math.max(limit, properties.rag().maxRows() * 2)
            );
            if (!candidates.isEmpty()) {
                transactionEmbeddingService.upsertMissingEmbeddings(
                        userId,
                        candidates.stream().map(RagRepository.TransactionSlice::transactionId).toList()
                );
                matches = txEmbeddingRepository.findNearest(
                        userId,
                        queryVector,
                        request.from(),
                        request.to(),
                        request.categories(),
                        request.amountMin(),
                        request.amountMax(),
                        candidateLimit
                );
            }
        }

        if (matches.isEmpty()) {
            return emptySearchResponse(userId, chatId);
        }

        List<UUID> ids = matches.stream().map(TxEmbeddingRepository.EmbeddingMatch::txId).toList();
        Map<UUID, RagRepository.TransactionSlice> sliceById = ragRepository.fetchTransactions(userId, ids).stream()
                .collect(Collectors.toMap(RagRepository.TransactionSlice::transactionId, slice -> slice));

        List<ScoredCandidate> scored = new ArrayList<>();
        LocalDate today = LocalDate.now(clock);
        for (TxEmbeddingRepository.EmbeddingMatch match : matches) {
            RagRepository.TransactionSlice slice = sliceById.get(match.txId());
            if (slice == null) {
                continue;
            }
            ScoreDetails scoreDetails = calculateScoreDetails(match.embedding(), slice, request, today, queryVector, queryTerms);
            scored.add(new ScoredCandidate(match.txId(), slice, scoreDetails));
        }
        scored.sort((a, b) -> Double.compare(b.score(), a.score()));

        int maxRows = properties.rag().maxRows();
        List<ScoredCandidate> filtered;
        if (request.excludePreviouslySeen() && chatId != null && !chatId.isBlank()) {
            List<String> txIdStrings = scored.stream()
                    .map(c -> c.slice().transactionId().toString())
                    .toList();
            List<String> unseen = diffTracker.filterNew(chatId, txIdStrings);
            filtered = scored.stream()
                    .filter(candidate -> unseen.contains(candidate.slice().transactionId().toString()))
                    .limit(maxRows)
                    .toList();
        } else {
            filtered = scored.stream()
                    .limit(maxRows)
                    .toList();
        }

        if (filtered.isEmpty()) {
            return emptySearchResponse(userId, chatId);
        }

        Dictionary dictionary = new Dictionary();
        List<TxRow> rows = new ArrayList<>();
        List<SearchReference> references = new ArrayList<>();
        for (ScoredCandidate candidate : filtered) {
            RagRepository.TransactionSlice slice = candidate.slice();
            String txCode = "t" + slice.transactionId().toString().replace("-", "").substring(0, 8);
            String merchantCode = dictionary.merchantCode(slice.merchantId(), slice.merchantName());
            String categoryCode = CsvCompressor.shortCategory(slice.category());
            rows.add(new TxRow(txCode, slice.occurredOn(), merchantCode, slice.amountCents(), categoryCode));
            dictionary.registerCategory(categoryCode, slice.category());
            references.add(new SearchReference(
                    txCode,
                    slice.transactionId(),
                    slice.occurredOn(),
                    PiiMasker.mask(slice.merchantName()),
                    slice.amountCents(),
                    PiiMasker.mask(slice.category()),
                    roundScore(candidate.score()),
                    candidate.scoreDetails().matchedTerms(),
                    buildReasons(candidate.scoreDetails(), request)
            ));
        }
        String csv = CsvCompressor.toCsv(rows);
        Stats stats = calculateStats(filtered);

        Map<String, Map<String, String>> dictPayload = Map.of(
                "merchants", dictionary.merchantDict(),
                "categories", dictionary.categoryDict()
        );
        int tokensEstimate = csv.length() / 4 + dictPayload.toString().length() / 4;

        auditLogger.record("/rag/search", userId, chatId, rows.size(), tokensEstimate);
        return new SearchResponse(csv, dictPayload, stats, references, traceId(), chatId);
    }

    private SearchResponse emptySearchResponse(UUID userId, String chatId) {
        auditLogger.record("/rag/search", userId, chatId, 0, 0);
        return new SearchResponse("", Map.of("merchants", Map.of(), "categories", Map.of()),
                new Stats(0, 0, 0), List.of(), traceId(), chatId);
    }

    @Transactional(readOnly = true)
    public SummariesResponse summaries(YearMonth month) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        return summariesForUser(userId, month);
    }

    public SummariesResponse summariesForUser(UUID userId, YearMonth month) {
        rlsGuard.setAppsecUser(userId);
        RagRepository.MonthlySummary summary = ragRepository.loadMonthlySummary(userId, month);
        if (summary.totals().count() == 0) {
            return new SummariesResponse(month.toString(),
                    new Totals(0, 0, 0),
                    List.of(),
                    List.of(),
                    traceId());
        }
        long net = summary.totals().incomeCents() + summary.totals().expenseCents();
        Totals totals = new Totals(
                summary.totals().incomeCents(),
                summary.totals().expenseCents(),
                net
        );
        List<CategoryBreakdown> categories = summary.categories().stream()
                .map(cat -> new CategoryBreakdown(
                        CsvCompressor.shortCategory(cat.category()),
                        PiiMasker.mask(cat.category()),
                        cat.count(),
                        cat.sumCents(),
                        cat.avgCents()
                ))
                .toList();
        List<MerchantBreakdown> merchants = summary.merchants().stream()
                .map(merch -> new MerchantBreakdown(
                        merch.merchantId().toString(),
                        PiiMasker.mask(merch.merchantName()),
                        merch.count(),
                        merch.sumCents()
                ))
                .toList();
        return new SummariesResponse(month.toString(), totals, categories, merchants, traceId());
    }

    @Transactional(readOnly = true)
    public AggregateResponse aggregate(AggregateRequest request) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        return aggregateForUser(userId, request);
    }

    public AggregateResponse aggregateForUser(UUID userId, AggregateRequest request) {
        rlsGuard.setAppsecUser(userId);
        RagRepository.Granularity granularity = switch (request.granularity()) {
            case "category" -> RagRepository.Granularity.CATEGORY;
            case "merchant" -> RagRepository.Granularity.MERCHANT;
            case "month" -> RagRepository.Granularity.MONTH;
            default -> throw new IllegalArgumentException("Unsupported granularity: " + request.granularity());
        };
        List<RagRepository.AggregateBucket> buckets = ragRepository.aggregate(userId, request.from(), request.to(), granularity);
        List<RagRepository.TimelinePoint> timeline = ragRepository.aggregateTimeline(userId, request.from(), request.to());
        List<AggregateBucket> responseBuckets = buckets.stream()
                .map(bucket -> new AggregateBucket(bucket.key(), PiiMasker.mask(bucket.label()), bucket.count(), bucket.sumCents(), bucket.avgCents()))
                .toList();
        List<TimelinePoint> responseTimeline = timeline.stream()
                .map(point -> new TimelinePoint(point.bucket(), point.count(), point.sumCents()))
                .toList();
        auditLogger.record("/rag/aggregate", userId, request.chatId(), responseBuckets.size(), responseBuckets.size() * 3);
        return new AggregateResponse(
                granularity.name().toLowerCase(Locale.ROOT),
                request.from(),
                request.to(),
                responseBuckets,
                responseTimeline,
                traceId(),
                request.chatId()
        );
    }

    @Transactional(readOnly = true)
    public AnalyticsSummary summariesOnly(YearMonth month, boolean generateAi) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        return analyticsService.getSummaryForUser(userId, month, generateAi);
    }

    private Stats calculateStats(List<ScoredCandidate> candidates) {
        if (candidates.isEmpty()) {
            return new Stats(0, 0, 0);
        }
        long sum = candidates.stream().mapToLong(c -> c.slice().amountCents()).sum();
        int avg = Math.toIntExact(sum / candidates.size());
        return new Stats(candidates.size(), sum, avg);
    }

    private ScoreDetails calculateScoreDetails(
            float[] matchEmbedding,
            RagRepository.TransactionSlice slice,
            SearchRequest request,
            LocalDate today,
            float[] queryVector,
            List<String> queryTerms
    ) {
        double vectorComponent = 0.0;
        if (queryVector != null && queryVector.length > 0 && matchEmbedding != null && matchEmbedding.length > 0) {
            vectorComponent = cosineSimilarity(queryVector, matchEmbedding);
        }
        List<String> matchedTerms = matchedTerms(queryTerms, slice);
        double lexicalComponent = queryTerms.isEmpty() ? 0.0 : (double) matchedTerms.size() / queryTerms.size();
        boolean merchantPhraseMatch = merchantPhraseMatch(request.q(), slice.merchantName());
        if (merchantPhraseMatch) {
            lexicalComponent = Math.max(lexicalComponent, 0.85);
        }
        long daysAgo = ChronoUnit.DAYS.between(slice.occurredOn(), today);
        double recencyComponent = 1.0 / (1 + Math.max(daysAgo, 0));
        double amountComponent = 0.0;
        if (request.amountMin() != null && request.amountMax() != null) {
            int mid = (request.amountMin() + request.amountMax()) / 2;
            int diff = Math.abs(slice.amountCents() - mid);
            amountComponent = 1.0 / (1 + diff);
        }
        double score;
        if ((queryVector == null || queryVector.length == 0) && queryTerms.isEmpty()) {
            score = recencyComponent * 0.75 + amountComponent * 0.25;
        } else {
            score = vectorComponent * 0.45 + lexicalComponent * 0.30 + recencyComponent * 0.20 + amountComponent * 0.05;
        }
        return new ScoreDetails(score, vectorComponent, lexicalComponent, recencyComponent, amountComponent, daysAgo,
                merchantPhraseMatch, matchedTerms);
    }

    private double cosineSimilarity(float[] a, float[] b) {
        int length = Math.min(a.length, b.length);
        if (length == 0) {
            return 0.0;
        }
        double dot = 0.0;
        double normA = 0.0;
        double normB = 0.0;
        for (int i = 0; i < length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) {
            return 0.0;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private String traceId() {
        return RequestContextHolder.get()
                .map(RequestContextHolder.RequestContext::traceId)
                .orElse(null);
    }

    private double roundScore(double score) {
        return Math.round(score * 1000d) / 1000d;
    }

    private List<String> buildReasons(ScoreDetails scoreDetails, SearchRequest request) {
        List<String> reasons = new ArrayList<>();
        if (scoreDetails.merchantPhraseMatch()) {
            reasons.add("merchant phrase match");
        }
        if (!scoreDetails.matchedTerms().isEmpty()) {
            reasons.add("matched terms: " + String.join(", ", scoreDetails.matchedTerms()));
        }
        if (scoreDetails.vectorSimilarity() >= 0.35) {
            reasons.add("semantic similarity");
        }
        if (scoreDetails.daysAgo() <= 30) {
            reasons.add("recent activity");
        }
        if (request.amountMin() != null || request.amountMax() != null) {
            reasons.add("amount filter");
        }
        if (reasons.isEmpty()) {
            reasons.add("ranked by recency");
        }
        return reasons;
    }

    private List<String> matchedTerms(List<String> queryTerms, RagRepository.TransactionSlice slice) {
        if (queryTerms.isEmpty()) {
            return List.of();
        }
        Set<String> docTerms = new LinkedHashSet<>();
        docTerms.addAll(extractQueryTerms(slice.merchantName()));
        docTerms.addAll(extractQueryTerms(slice.category()));
        docTerms.addAll(extractQueryTerms(slice.description()));
        return queryTerms.stream()
                .filter(docTerms::contains)
                .limit(5)
                .toList();
    }

    private boolean merchantPhraseMatch(String query, String merchantName) {
        String normalizedQuery = normalizeText(query);
        String normalizedMerchant = normalizeText(merchantName);
        if (normalizedQuery.isBlank() || normalizedMerchant.isBlank()) {
            return false;
        }
        return normalizedQuery.contains(normalizedMerchant) || normalizedMerchant.contains(normalizedQuery);
    }

    private List<String> extractQueryTerms(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(normalizeText(text).split(" "))
                .map(String::trim)
                .filter(token -> token.length() >= 3)
                .filter(token -> !QUERY_STOP_WORDS.contains(token))
                .distinct()
                .toList();
    }

    private List<String> expandQueryTerms(List<String> queryTerms) {
        if (queryTerms.isEmpty()) {
            return List.of();
        }
        LinkedHashSet<String> expanded = new LinkedHashSet<>(queryTerms);
        for (String term : queryTerms) {
            expanded.addAll(QUERY_SYNONYMS.getOrDefault(term, List.of()));
        }
        return List.copyOf(expanded);
    }

    private String normalizeText(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        String withWordBoundaries = text.replaceAll("([a-z])([A-Z])", "$1 $2");
        return withWordBoundaries
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", " ")
                .trim()
                .replaceAll("\\s+", " ");
    }

    public record SearchRequest(
            String q,
            LocalDate from,
            LocalDate to,
            List<String> categories,
            Integer amountMin,
            Integer amountMax,
            Integer topK,
            boolean excludePreviouslySeen
    ) {
    }

    public record AggregateRequest(
            LocalDate from,
            LocalDate to,
            String granularity,
            String chatId
    ) {
    }

    public record SearchResponse(
            String rowsCsv,
            Map<String, Map<String, String>> dict,
            Stats stats,
            List<SearchReference> references,
            String traceId,
            String chatId
    ) {
    }

    public record Stats(int count, long sum, long avg) {
    }

    public record SearchReference(
            String txCode,
            UUID transactionId,
            LocalDate occurredOn,
            String merchant,
            int amountCents,
            String category,
            double score,
            List<String> matchedTerms,
            List<String> reasons
    ) {
    }

    public record SummariesResponse(
            String month,
            Totals totals,
            List<CategoryBreakdown> categories,
            List<MerchantBreakdown> merchants,
            String traceId
    ) {
    }

    public record Totals(long income, long expense, long net) {
    }

    public record CategoryBreakdown(
            String code,
            String label,
            int count,
            long sum,
            long avg
    ) {
    }

    public record MerchantBreakdown(
            String merchantId,
            String label,
            int count,
            long sum
    ) {
    }

    public record AggregateResponse(
            String granularity,
            LocalDate from,
            LocalDate to,
            List<AggregateBucket> buckets,
            List<TimelinePoint> timeline,
            String traceId,
            String chatId
    ) {
    }

    public record AggregateBucket(
            String key,
            String label,
            int count,
            long sum,
            long avg
    ) {
    }

    public record TimelinePoint(
            String bucket,
            int count,
            long sum
    ) {
    }

    private record ScoredCandidate(
            UUID id,
            RagRepository.TransactionSlice slice,
            ScoreDetails scoreDetails
    ) {
        double score() {
            return scoreDetails.score();
        }
    }

    private record ScoreDetails(
            double score,
            double vectorSimilarity,
            double lexicalOverlap,
            double recency,
            double amount,
            long daysAgo,
            boolean merchantPhraseMatch,
            List<String> matchedTerms
    ) {
    }

    private static final class Dictionary {
        private final Map<UUID, String> merchantCodes = new LinkedHashMap<>();
        private final Map<String, String> merchants = new LinkedHashMap<>();
        private final Map<String, String> categories = new LinkedHashMap<>();

        String merchantCode(UUID merchantId, String merchantName) {
            return merchantCodes.computeIfAbsent(merchantId, id -> {
                String code = "m" + (merchantCodes.size() + 1);
                merchants.put(code, PiiMasker.mask(merchantName));
                return code;
            });
        }

        void registerCategory(String shortCode, String label) {
            categories.putIfAbsent(shortCode, PiiMasker.mask(label));
        }

        Map<String, String> merchantDict() {
            return merchants;
        }

        Map<String, String> categoryDict() {
            return categories;
        }
    }
}
