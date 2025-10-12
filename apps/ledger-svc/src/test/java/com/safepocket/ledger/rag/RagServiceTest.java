package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.analytics.AnalyticsService;
import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.rag.RagRepository.AggregateBucket;
import com.safepocket.ledger.rag.RagRepository.CategorySummary;
import com.safepocket.ledger.rag.RagRepository.MerchantSummary;
import com.safepocket.ledger.rag.RagRepository.MonthlySummary;
import com.safepocket.ledger.rag.RagRepository.TimelinePoint;
import com.safepocket.ledger.rag.RagRepository.Totals;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class RagServiceTest {

    @Mock
    private AuthenticatedUserProvider userProvider;
    @Mock
    private RlsGuard rlsGuard;
    @Mock
    private RagRepository ragRepository;
    @Mock
    private TxEmbeddingRepository txEmbeddingRepository;
    @Mock
    private TransactionEmbeddingService transactionEmbeddingService;
    @Mock
    private RagAuditLogger auditLogger;
    @Mock
    private AnalyticsService analyticsService;

    private EmbeddingService embeddingService;
    private ChatSessionDiffTracker diffTracker;
    private RagService service;

    private final UUID userId = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private final UUID merchantId = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private final UUID transactionId = UUID.fromString("33333333-3333-3333-3333-333333333333");

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        SafepocketProperties props = new SafepocketProperties(
                new SafepocketProperties.Cognito("https://example.com", "aud", false),
                new SafepocketProperties.Plaid("id", "sec", "redir", "base", "env", null, null),
                new SafepocketProperties.Ai("openai", "model", "https://api.example.com", null, null),
                new SafepocketProperties.Security("12345678901234567890123456789012"),
                new SafepocketProperties.Rag("pgvector", "text-embedding-3-small", 20, 8)
        );
        embeddingService = new EmbeddingService(props);
        diffTracker = new ChatSessionDiffTracker();
        service = new RagService(
                userProvider,
                rlsGuard,
                ragRepository,
                txEmbeddingRepository,
                transactionEmbeddingService,
                embeddingService,
                diffTracker,
                auditLogger,
                props,
                analyticsService
        );
        when(userProvider.requireCurrentUserId()).thenReturn(userId);
    }

    @Test
    void searchReturnsCsvAndDictionary() {
        YearMonth month = YearMonth.of(2025, 9);
        when(txEmbeddingRepository.findNearest(eq(userId), any(), any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of(new TxEmbeddingRepository.EmbeddingMatch(transactionId, merchantId, embeddingService.embedDeterministic("Starbucks latte"), month, 460, "EatingOut")));
        when(ragRepository.fetchTransactions(eq(userId), any()))
                .thenReturn(List.of(new RagRepository.TransactionSlice(transactionId, LocalDate.of(2025, 9, 15), 460, "EatingOut", "Starbucks latte", merchantId, "Starbucks")));

        RagService.SearchResponse response = service.search(
                new RagService.SearchRequest(null, null, null, null, null, null, 10),
                "chat-1"
        );

        assertThat(response.rowsCsv()).isEqualTo("t33333333,250915,m1,460,eo");
        assertThat(response.dict().get("merchants")).containsEntry("m1", "Starbucks");
        assertThat(response.stats().count()).isEqualTo(1);
        assertThat(response.chatId()).isEqualTo("chat-1");
        verify(auditLogger).record(eq("/rag/search"), eq(userId), eq("chat-1"), eq(1), anyInt());
    }

    @Test
    void searchSkipsPreviouslySentTransactions() {
        YearMonth month = YearMonth.of(2025, 9);
        when(txEmbeddingRepository.findNearest(eq(userId), any(), any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of(new TxEmbeddingRepository.EmbeddingMatch(transactionId, merchantId, embeddingService.embedDeterministic("Coffee"), month, 500, "EatingOut")));
        when(ragRepository.fetchTransactions(eq(userId), any()))
                .thenReturn(List.of(new RagRepository.TransactionSlice(transactionId, LocalDate.of(2025, 9, 15), 500, "EatingOut", "Coffee", merchantId, "Blue Bottle")));

        service.search(new RagService.SearchRequest(null, null, null, null, null, null, 10), "chat-2");
        RagService.SearchResponse second = service.search(new RagService.SearchRequest(null, null, null, null, null, null, 10), "chat-2");

        assertThat(second.rowsCsv()).isEmpty();
        assertThat(second.stats().count()).isZero();
    }

    @Test
    void searchReturnsEmptyWhenNoMatches() {
        when(txEmbeddingRepository.findNearest(eq(userId), any(), any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        RagService.SearchResponse response = service.search(new RagService.SearchRequest(null, null, null, null, null, null, 5), "chat-3");
        assertThat(response.rowsCsv()).isEmpty();
        assertThat(response.dict().get("merchants")).isEmpty();
        assertThat(response.chatId()).isEqualTo("chat-3");
    }

    @Test
    void summariesMapToDto() {
        YearMonth month = YearMonth.of(2025, 9);
        MonthlySummary summary = new MonthlySummary(
                new Totals(12_000, -34_000, 5),
                List.of(new CategorySummary("EatingOut", 3, -9_000, -3_000)),
                List.of(new MerchantSummary(merchantId, "Starbucks", 2, -5_000))
        );
        when(ragRepository.loadMonthlySummary(userId, month)).thenReturn(summary);

        RagService.SummariesResponse response = service.summaries(month);
        assertThat(response.totals().income()).isEqualTo(12_000);
        assertThat(response.categories()).hasSize(1);
        assertThat(response.merchants().get(0).label()).isEqualTo("Starbucks");
    }

    @Test
    void aggregateMapsBucketsAndTimeline() {
        when(ragRepository.aggregate(eq(userId), any(), any(), eq(RagRepository.Granularity.CATEGORY)))
                .thenReturn(List.of(new AggregateBucket("EatingOut", "EatingOut", 2, -8000, -4000)));
        when(ragRepository.aggregateTimeline(eq(userId), any(), any()))
                .thenReturn(List.of(new TimelinePoint("2025-09", 2, -8000)));

        RagService.AggregateResponse response = service.aggregate(
                new RagService.AggregateRequest(LocalDate.of(2025, 9, 1), LocalDate.of(2025, 9, 30), "category", "chat-4")
        );

        assertThat(response.buckets()).hasSize(1);
        assertThat(response.timeline().get(0).bucket()).isEqualTo("2025-09");
        assertThat(response.chatId()).isEqualTo("chat-4");
        verify(auditLogger).record(eq("/rag/aggregate"), eq(userId), eq("chat-4"), eq(1), anyInt());
    }
}
