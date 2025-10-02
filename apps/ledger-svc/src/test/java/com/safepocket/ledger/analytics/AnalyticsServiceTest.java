package com.safepocket.ledger.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.ai.AiHighlightService;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class AnalyticsServiceTest {

    @Mock
    private TransactionRepository transactionRepository;

    @Mock
    private AuthenticatedUserProvider authenticatedUserProvider;

    @Mock
    private RlsGuard rlsGuard;

    @Mock
    private AnomalyDetectionService anomalyDetectionService;

    @Mock
    private AiHighlightService aiHighlightService;

    private AnalyticsService analyticsService;

    private final UUID userId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        analyticsService = new AnalyticsService(transactionRepository, authenticatedUserProvider, rlsGuard, anomalyDetectionService, aiHighlightService);
    }

    @Test
    void aggregatesTotalsAndMerchants() {
        YearMonth month = YearMonth.of(2024, 3);
        List<Transaction> transactions = List.of(
                transaction("Amazon", -120.45),
                transaction("Payroll", 4200.0),
                transaction("Whole Foods", -68.2)
        );
        when(authenticatedUserProvider.requireCurrentUserId()).thenReturn(userId);
        when(transactionRepository.findByUserIdAndMonth(userId, month)).thenReturn(transactions);
        when(anomalyDetectionService.detectAnomalies(transactions)).thenReturn(List.of());
        when(aiHighlightService.generateHighlight(transactions, List.of()))
                .thenReturn(new AnalyticsSummary.AiHighlight("title", "summary", AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL, List.of()));

        AnalyticsSummary summary = analyticsService.getSummary(month);

        assertThat(summary.totals().income()).isEqualByComparingTo(BigDecimal.valueOf(4200.0));
        assertThat(summary.totals().expense()).isEqualByComparingTo(BigDecimal.valueOf(-188.65));
        assertThat(summary.merchants()).hasSize(3);
        assertThat(summary.categories()).isNotEmpty();
    }

    private Transaction transaction(String merchant, double amount) {
        String category = amount >= 0 ? "Income" : "Misc";
        return new Transaction(
                UUID.randomUUID(),
                userId,
                UUID.randomUUID(),
                merchant,
                BigDecimal.valueOf(amount),
                "USD",
                Instant.parse("2024-03-15T12:00:00Z"),
                Instant.parse("2024-03-15T11:00:00Z"),
                false,
                category,
                merchant,
                Optional.empty(),
                Optional.empty()
        );
    }
}
