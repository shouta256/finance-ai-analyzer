package com.safepocket.ledger.analytics;

import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.DoubleSummaryStatistics;
import java.util.List;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
public class AnomalyDetectionService {

    private static final double Z_SCORE_THRESHOLD = 2.5d;
    private static final double IQR_MULTIPLIER = 1.5d;

    public List<AnalyticsSummary.AnomalyInsight> detectAnomalies(List<Transaction> transactions) {
        List<Transaction> debitTransactions = transactions.stream()
                .filter(tx -> tx.amount().compareTo(BigDecimal.ZERO) < 0)
                .collect(Collectors.toCollection(ArrayList::new));
        if (debitTransactions.size() < 3) {
            return List.of();
        }
        List<Double> magnitudes = debitTransactions.stream()
                .map(tx -> tx.amount().abs().doubleValue())
                .sorted()
                .toList();
        DoubleSummaryStatistics stats = magnitudes.stream().mapToDouble(Double::doubleValue).summaryStatistics();
        double mean = stats.getAverage();
        double variance = magnitudes.stream()
                .mapToDouble(value -> Math.pow(value - mean, 2))
                .average()
                .orElse(0d);
        double stdDev = Math.sqrt(variance);
        double q1 = percentile(magnitudes, 25);
        double q3 = percentile(magnitudes, 75);
        double iqr = q3 - q1;
        double iqrUpper = q3 + IQR_MULTIPLIER * iqr;
        double median = percentile(magnitudes, 50);
        double totalMagnitude = magnitudes.stream().mapToDouble(Double::doubleValue).sum();

        List<AnalyticsSummary.AnomalyInsight> anomalies = new ArrayList<>();
        for (Transaction tx : debitTransactions) {
            double magnitude = tx.amount().abs().doubleValue();
            double zScore = stdDev == 0 ? 0 : (magnitude - mean) / stdDev;
            boolean zScoreAnomaly = Math.abs(zScore) >= Z_SCORE_THRESHOLD;
            boolean iqrAnomaly = magnitude > iqrUpper;
            if (zScoreAnomaly || iqrAnomaly) {
                BigDecimal amount = tx.amount().setScale(2, RoundingMode.HALF_UP);
                double rawDelta = Math.max(0d, magnitude - median);
                BigDecimal deltaAmount = BigDecimal.valueOf(rawDelta).setScale(2, RoundingMode.HALF_UP);
                BigDecimal impactPercent = totalMagnitude == 0
                        ? BigDecimal.ZERO
                        : BigDecimal.valueOf((magnitude / totalMagnitude) * 100).setScale(2, RoundingMode.HALF_UP);
                AnalyticsSummary.AnomalyInsight insight = new AnalyticsSummary.AnomalyInsight(
                        tx.id().toString(),
                        zScoreAnomaly ? com.safepocket.ledger.model.AnomalyScore.Method.Z_SCORE : com.safepocket.ledger.model.AnomalyScore.Method.IQR,
                        amount,
                        deltaAmount,
                        impactPercent,
                        tx.merchantName(),
                        tx.occurredAt(),
                        commentaryFor(tx, deltaAmount, impactPercent, BigDecimal.valueOf(mean).setScale(2, RoundingMode.HALF_UP))
                );
                anomalies.add(insight);
            }
        }
        anomalies.sort(Comparator.comparing(AnalyticsSummary.AnomalyInsight::occurredAt).reversed());
        return anomalies;
    }

    private double percentile(List<Double> sortedValues, double percentile) {
        if (sortedValues.isEmpty()) {
            return 0d;
        }
        double index = percentile / 100.0 * (sortedValues.size() - 1);
        int lower = (int) Math.floor(index);
        int upper = (int) Math.ceil(index);
        if (lower == upper) {
            return sortedValues.get(lower);
        }
        double weight = index - lower;
        return sortedValues.get(lower) * (1 - weight) + sortedValues.get(upper) * weight;
    }

    private String commentaryFor(Transaction tx, BigDecimal delta, BigDecimal impactPercent, BigDecimal averageSpend) {
        StringBuilder commentary = new StringBuilder();
        commentary.append("Detected spend anomaly for ")
                .append(tx.merchantName())
                .append(" with amount $")
                .append(tx.amount().abs());
        commentary.append("; typical spend $").append(averageSpend);
        commentary.append("; delta $").append(delta);
        commentary.append("; budget impact ").append(impactPercent).append("%");
        return commentary.toString();
    }
}
