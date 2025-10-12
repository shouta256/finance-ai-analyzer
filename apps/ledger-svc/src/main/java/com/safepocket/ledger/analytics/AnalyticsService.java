package com.safepocket.ledger.analytics;

import com.safepocket.ledger.ai.AiHighlightService;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.security.RlsGuard;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.YearMonth;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

@Service
public class AnalyticsService {

    private final TransactionRepository transactionRepository;
    private final AuthenticatedUserProvider authenticatedUserProvider;
    private final RlsGuard rlsGuard;
    private final AnomalyDetectionService anomalyDetectionService;
    private final AiHighlightService aiHighlightService;

    public AnalyticsService(
            TransactionRepository transactionRepository,
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            AnomalyDetectionService anomalyDetectionService,
            AiHighlightService aiHighlightService
    ) {
        this.transactionRepository = transactionRepository;
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
        this.anomalyDetectionService = anomalyDetectionService;
        this.aiHighlightService = aiHighlightService;
    }

    public AnalyticsSummary getSummary(YearMonth month) {
        return getSummary(month, false);
    }

    public AnalyticsSummary getSummary(YearMonth month, boolean generateAi) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        return getSummaryForUser(userId, month, generateAi);
    }

    public AnalyticsSummary getSummaryForUser(UUID userId, YearMonth month, boolean generateAi) {
        return buildSummary(userId, month, generateAi);
    }

    private AnalyticsSummary buildSummary(UUID userId, YearMonth month, boolean generateAi) {
        rlsGuard.setAppsecUser(userId);
        RequestContextHolder.setUserId(userId);
        List<Transaction> transactions = transactionRepository.findByUserIdAndMonth(userId, month);
        List<AnalyticsSummary.AnomalyInsight> anomalies = anomalyDetectionService.detectAnomalies(transactions);
        AnalyticsSummary.AiHighlight highlight = aiHighlightService.generateHighlight(userId, month, transactions, anomalies, generateAi);
        AnalyticsSummary.Totals totals = calculateTotals(transactions);
        List<AnalyticsSummary.CategoryBreakdown> categories = calculateCategoryBreakdown(transactions);
        List<AnalyticsSummary.MerchantBreakdown> merchants = calculateTopMerchants(transactions);
        String traceId = RequestContextHolder.get()
                .map(RequestContextHolder.RequestContext::traceId)
                .orElse(null);
        return new AnalyticsSummary(month, totals, categories, merchants, anomalies, highlight, traceId);
    }

    private AnalyticsSummary.Totals calculateTotals(List<Transaction> transactions) {
        BigDecimal income = transactions.stream()
                .map(Transaction::amount)
                .filter(amount -> amount.compareTo(BigDecimal.ZERO) > 0)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);
        BigDecimal expense = transactions.stream()
                .map(Transaction::amount)
                .filter(amount -> amount.compareTo(BigDecimal.ZERO) < 0)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);
        BigDecimal net = income.add(expense);
        return new AnalyticsSummary.Totals(income, expense, net.setScale(2, RoundingMode.HALF_UP));
    }

    private List<AnalyticsSummary.CategoryBreakdown> calculateCategoryBreakdown(List<Transaction> transactions) {
        Map<String, BigDecimal> grouped = transactions.stream()
                .collect(Collectors.groupingBy(Transaction::category,
                        Collectors.reducing(BigDecimal.ZERO, Transaction::amount, BigDecimal::add)));
        BigDecimal totalExpenses = grouped.values().stream()
                .filter(value -> value.compareTo(BigDecimal.ZERO) < 0)
                .map(BigDecimal::abs)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return grouped.entrySet().stream()
                .filter(entry -> entry.getValue().compareTo(BigDecimal.ZERO) < 0)
                .map(entry -> {
                    BigDecimal amount = entry.getValue();
                    BigDecimal percentage = totalExpenses.compareTo(BigDecimal.ZERO) == 0
                            ? BigDecimal.ZERO
                            : amount.abs().multiply(BigDecimal.valueOf(100)).divide(totalExpenses, 2, RoundingMode.HALF_UP);
                    return new AnalyticsSummary.CategoryBreakdown(entry.getKey(), amount.setScale(2, RoundingMode.HALF_UP), percentage);
                })
                .sorted(Comparator.comparing((AnalyticsSummary.CategoryBreakdown breakdown) -> breakdown.amount().abs()).reversed())
                .limit(8)
                .toList();
    }

    private List<AnalyticsSummary.MerchantBreakdown> calculateTopMerchants(List<Transaction> transactions) {
        Map<String, List<Transaction>> byMerchant = transactions.stream()
                .collect(Collectors.groupingBy(Transaction::merchantName));
        return byMerchant.entrySet().stream()
                .map(entry -> {
                    BigDecimal total = entry.getValue().stream()
                            .map(Transaction::amount)
                            .reduce(BigDecimal.ZERO, BigDecimal::add)
                            .setScale(2, RoundingMode.HALF_UP);
                    int count = (int) entry.getValue().stream().count();
                    return new AnalyticsSummary.MerchantBreakdown(entry.getKey(), total, count);
                })
                .sorted(Comparator.comparing((AnalyticsSummary.MerchantBreakdown breakdown) -> breakdown.amount().abs()).reversed())
                .limit(5)
                .toList();
    }
}
