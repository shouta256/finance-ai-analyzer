package com.safepocket.ledger.model;

import java.math.BigDecimal;
import java.time.YearMonth;
import java.util.List;

public record AnalyticsSummary(
        YearMonth month,
        Totals totals,
        List<CategoryBreakdown> categories,
        List<MerchantBreakdown> merchants,
        List<AnomalyInsight> anomalies,
        AiHighlight aiHighlight,
        SafeToSpend safeToSpend,
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
            AnomalyScore.Method method,
            BigDecimal amount,
            BigDecimal deltaAmount,
            BigDecimal budgetImpactPercent,
            String merchantName,
            java.time.Instant occurredAt,
            String commentary
    ) {
    }

    public record AiHighlight(String title, String summary, Sentiment sentiment, List<String> recommendations) {
        public enum Sentiment {
            POSITIVE,
            NEUTRAL,
            NEGATIVE
        }
    }

    public record SafeToSpend(
            java.time.LocalDate cycleStart,
            java.time.LocalDate cycleEnd,
            BigDecimal safeToSpendToday,
            BigDecimal hardCap,
            BigDecimal dailyBase,
            BigDecimal dailyAdjusted,
            BigDecimal rollToday,
            BigDecimal paceRatio,
            BigDecimal adjustmentFactor,
            int daysRemaining,
            BigDecimal variableBudget,
            BigDecimal variableSpent,
            BigDecimal remainingVariableBudget,
            boolean danger,
            List<String> notes
    ) {
    }
}
