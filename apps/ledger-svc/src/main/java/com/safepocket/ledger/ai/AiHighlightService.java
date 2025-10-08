package com.safepocket.ledger.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class AiHighlightService {

    private static final Logger log = LoggerFactory.getLogger(AiHighlightService.class);

    private final OpenAiResponsesClient openAiClient;
    private final ObjectMapper objectMapper;

    public AiHighlightService(OpenAiResponsesClient openAiClient, ObjectMapper objectMapper) {
        this.openAiClient = openAiClient;
        this.objectMapper = objectMapper;
    }

    public AnalyticsSummary.AiHighlight generateHighlight(
            List<Transaction> transactions,
            List<AnalyticsSummary.AnomalyInsight> anomalies,
            boolean generateAi) {
        if (transactions.isEmpty()) {
            return new AnalyticsSummary.AiHighlight(
                    "No activity",
                    "No transactions recorded for this period.",
                    AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL,
                    List.of());
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
                .max(Comparator.comparing(anomaly -> Optional.ofNullable(anomaly.deltaAmount()).orElse(BigDecimal.ZERO)))
                .orElse(null);
        AnalyticsSummary.AiHighlight.Sentiment sentiment = totalIncome.compareTo(totalSpend) >= 0
                ? AnalyticsSummary.AiHighlight.Sentiment.POSITIVE
                : AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL;

        if (!generateAi || !openAiClient.hasCredentials()) {
            return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
        }

        String prompt = buildPrompt(transactions, anomalies, totalIncome, totalSpend, topAnomaly);
        return openAiClient.generateText(
                        List.of(new OpenAiResponsesClient.Message("user", prompt)),
                        700)
                .map(response -> buildHighlightFromResponse(response, totalIncome, totalSpend, topAnomaly, sentiment))
                .orElseGet(() -> {
                    log.warn("AI highlight: OpenAI 応答が取得できなかったため fallback 表示");
                    return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
                });
    }

    private AnalyticsSummary.AiHighlight buildHighlightFromResponse(
            String rawResponse,
            BigDecimal totalIncome,
            BigDecimal totalSpend,
            AnalyticsSummary.AnomalyInsight topAnomaly,
            AnalyticsSummary.AiHighlight.Sentiment sentiment) {
        String normalized = rawResponse == null ? "" : rawResponse.trim();
        try {
            if (!normalized.startsWith("{")) {
                normalized = "{\"summary\": " + objectMapper.writeValueAsString(normalized) + "}";
            }

            Map<String, Object> ai = objectMapper.readValue(normalized, new TypeReference<Map<String, Object>>() {});
            String title = ai.get("title") != null ? ai.get("title").toString() : "Monthly financial health";
            String summary = ai.get("summary") != null ? ai.get("summary").toString() : "";
            String sentimentStr = ai.get("sentiment") != null ? ai.get("sentiment").toString() : sentiment.name();
            List<String> recommendations = extractRecommendations(ai.get("recommendations"));

            AnalyticsSummary.AiHighlight.Sentiment aiSentiment = switch (sentimentStr.toUpperCase()) {
                case "POSITIVE" -> AnalyticsSummary.AiHighlight.Sentiment.POSITIVE;
                case "NEGATIVE" -> AnalyticsSummary.AiHighlight.Sentiment.NEGATIVE;
                default -> sentiment;
            };
            return new AnalyticsSummary.AiHighlight(title, summary, aiSentiment, recommendations);
        } catch (Exception ex) {
            log.warn("AI highlight: failed to parse response '{}', falling back", normalized);
            return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
        }
    }

    private List<String> extractRecommendations(Object recObj) {
        if (recObj instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        return List.of();
    }

    private AnalyticsSummary.AiHighlight fallbackHighlight(
            BigDecimal totalIncome,
            BigDecimal totalSpend,
            AnalyticsSummary.AnomalyInsight topAnomaly,
            AnalyticsSummary.AiHighlight.Sentiment sentiment) {
        BigDecimal net = totalIncome.subtract(totalSpend).setScale(2, RoundingMode.HALF_UP);
        StringBuilder summary = new StringBuilder();
        summary.append("Income $")
                .append(totalIncome)
                .append(" vs spend $")
                .append(totalSpend)
                .append(" → net $")
                .append(net)
                .append(". ");
        if (topAnomaly != null) {
            summary.append("Largest anomaly: ")
                    .append(topAnomaly.merchantName())
                    .append(" ($")
                    .append(Optional.ofNullable(topAnomaly.amount()).orElse(BigDecimal.ZERO).abs())
                    .append("). Typical delta $")
                    .append(Optional.ofNullable(topAnomaly.deltaAmount()).orElse(BigDecimal.ZERO))
                    .append(". ");
        }
        summary.append("Overall sentiment: ").append(sentiment.name()).append(".");

        List<String> recs = new ArrayList<>();
        if (net.compareTo(BigDecimal.ZERO) < 0) {
            recs.add("Net negative this month — review top 3 expense categories and defer non-essentials next cycle");
        } else if (net.compareTo(BigDecimal.ZERO) > 0) {
            recs.add("Net positive — consider allocating 10–20% to savings or paying down debt");
        } else {
            recs.add("Balanced inflow/outflow — monitor upcoming recurring charges");
        }
        if (topAnomaly != null && topAnomaly.amount().abs().compareTo(new BigDecimal("500")) > 0) {
            recs.add("Validate the large charge at " + topAnomaly.merchantName() + " and set a spending alert");
        }
        recs.add("Schedule a budget review and update category limits");

        return new AnalyticsSummary.AiHighlight(
                "Monthly financial health",
                summary.toString(),
                sentiment,
                List.copyOf(recs));
    }

    private String buildPrompt(
            List<Transaction> transactions,
            List<AnalyticsSummary.AnomalyInsight> anomalies,
            BigDecimal totalIncome,
            BigDecimal totalSpend,
            AnalyticsSummary.AnomalyInsight topAnomaly) {
        DateTimeFormatter dtf = DateTimeFormatter.ISO_INSTANT;
        StringBuilder sb = new StringBuilder();
        sb.append("You are a concise financial assistant. Return ONLY compact JSON with keys: title, summary, sentiment (POSITIVE|NEUTRAL|NEGATIVE), recommendations (array of strings).\n");
        sb.append("The 'summary' should be 3-6 sentences, actionable, and reference net flow, notable spikes, and any savings/debt guidance.\n");
        sb.append("Base facts: totalIncome=").append(totalIncome)
                .append(", totalSpend=").append(totalSpend)
                .append(", net=").append(totalIncome.subtract(totalSpend)).append(".\n");
        if (topAnomaly != null) {
            sb.append("Top anomaly: ").append(topAnomaly.merchantName()).append(", amount=")
                    .append(topAnomaly.amount().abs()).append(".\n");
        }
        sb.append("Transactions (truncated to 20):\n");
        transactions.stream().limit(20).forEach(t -> sb.append("- ")
                .append(dtf.format(t.occurredAt())).append(" ")
                .append(t.merchantName()).append(": ")
                .append(t.amount()).append(" ")
                .append(t.category()).append("\n"));
        sb.append("Anomalies (top 5):\n");
        anomalies.stream().limit(5).forEach(a -> sb.append("- ")
                .append(a.merchantName()).append(": ")
                .append(a.amount()).append(", delta=")
                .append(Optional.ofNullable(a.deltaAmount()).orElse(BigDecimal.ZERO)).append(", budgetImpact=")
                .append(Optional.ofNullable(a.budgetImpactPercent()).orElse(BigDecimal.ZERO)).append("%\n"));
        sb.append("Respond ONLY with compact JSON, no markdown.");
        return sb.toString();
    }
}
