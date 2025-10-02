package com.safepocket.ledger.ai;

import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Comparator;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class AiHighlightService {

    public AnalyticsSummary.AiHighlight generateHighlight(
            List<Transaction> transactions,
            List<AnalyticsSummary.AnomalyInsight> anomalies
    ) {
        if (transactions.isEmpty()) {
            return new AnalyticsSummary.AiHighlight(
                    "No activity",
                    "No transactions recorded for this period.",
                    AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL,
                    List.of()
            );
        }
        BigDecimal totalSpend = transactions.stream()
                .map(Transaction::amount)
                .filter(amount -> amount.compareTo(BigDecimal.ZERO) < 0)
                .map(BigDecimal::abs)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);
        BigDecimal totalIncome = transactions.stream()
                .map(Transaction::amount)
                .filter(amount -> amount.compareTo(BigDecimal.ZERO) > 0)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);
        AnalyticsSummary.AnomalyInsight topAnomaly = anomalies.stream()
                .max(Comparator.comparing(AnalyticsSummary.AnomalyInsight::score))
                .orElse(null);
        AnalyticsSummary.AiHighlight.Sentiment sentiment = totalIncome.compareTo(totalSpend) >= 0
                ? AnalyticsSummary.AiHighlight.Sentiment.POSITIVE
                : AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL;
        StringBuilder summary = new StringBuilder();
        summary.append("Income $")
                .append(totalIncome)
                .append(" vs spend $")
                .append(totalSpend)
                .append(".");
        if (topAnomaly != null) {
            summary.append(" Largest anomaly: ")
                    .append(topAnomaly.merchantName())
                    .append(" ($")
                    .append(topAnomaly.amount().abs())
                    .append(").");
        }
        List<String> recommendations = List.of(
                "Schedule a review for merchants with anomaly scores",
                "Consider allocating surplus to savings if positive net flow"
        );
        return new AnalyticsSummary.AiHighlight(
                "Monthly financial health",
                summary.toString(),
                sentiment,
                recommendations
        );
    }
}
