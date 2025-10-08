package com.safepocket.ledger.controller.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public record AnalyticsSummaryResponseDto(
        String month,
        Totals totals,
        List<CategoryBreakdown> byCategory,
        List<MerchantBreakdown> topMerchants,
        List<AnomalyInsight> anomalies,
        AiHighlight aiHighlight,
        String traceId
) {
    public record Totals(BigDecimal income, BigDecimal expense, BigDecimal net) {
    }

    public record CategoryBreakdown(String category, BigDecimal amount, BigDecimal percentage) {
    }

    public record MerchantBreakdown(String merchant, BigDecimal amount, int transactionCount) {
    }

    public record AnomalyInsight(
            String transactionId,
            String method,
            BigDecimal amount,
            BigDecimal deltaAmount,
            BigDecimal budgetImpactPercent,
            Instant occurredAt,
            String merchantName,
            String commentary) {
    }

    public record AiHighlight(String title, String summary, String sentiment, List<String> recommendations) {
    }
}
