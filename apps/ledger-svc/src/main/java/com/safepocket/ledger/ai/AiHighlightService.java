package com.safepocket.ledger.ai;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class AiHighlightService {

        private static final Logger log = LoggerFactory.getLogger(AiHighlightService.class);
        private final SafepocketProperties properties;
        private final RestClient restClient;
        private final ObjectMapper objectMapper;

        public AiHighlightService(SafepocketProperties properties, ObjectMapper objectMapper) {
                this.properties = properties;
                this.objectMapper = objectMapper;
                // Build a simple RestClient; Spring 6 RestClient is available with spring-boot-starter-web
                ClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
                this.restClient = RestClient.builder()
                        .requestFactory(requestFactory)
                        .build();
        }

            public AnalyticsSummary.AiHighlight generateHighlight(
                    List<Transaction> transactions,
                    List<AnalyticsSummary.AnomalyInsight> anomalies,
                    boolean generateAi
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
                        // If not requested or no API key, return deterministic fallback
                        if (!generateAi || properties.ai().apiKey() == null || properties.ai().apiKey().isBlank()) {
                        return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
                }

                try {
                        String prompt = buildPrompt(transactions, anomalies, totalIncome, totalSpend, topAnomaly);
                        OpenAiResponsesRequest requestBody = new OpenAiResponsesRequest(properties.ai().model(), prompt);

                            OpenAiResponsesResponse response = this.restClient.post()
                                    .uri(properties.ai().endpoint())
                                        .contentType(MediaType.APPLICATION_JSON)
                                        .headers(headers -> headers.setBearerAuth(properties.ai().apiKey()))
                                        .body(requestBody)
                                        .retrieve()
                                        .body(OpenAiResponsesResponse.class);

                                        if (response == null || response.outputText() == null || response.outputText().isBlank()) {
                                log.warn("OpenAI response empty; using fallback");
                                return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
                        }

                        // We expect the model to return a compact JSON with fields
                        // { "title": "...", "summary": "...", "sentiment": "POSITIVE|NEUTRAL|NEGATIVE", "recommendations": ["..."] }
                                        Map<String, Object> ai = objectMapper.readValue(response.outputText(), new TypeReference<Map<String, Object>>(){});
                                        String title = ai.get("title") != null ? ai.get("title").toString() : "Monthly financial health";
                                        String summary = ai.get("summary") != null ? ai.get("summary").toString() : "";
                                        String sentimentStr = ai.get("sentiment") != null ? ai.get("sentiment").toString() : sentiment.name();
                                        List<String> recommendations;
                                        Object recObj = ai.get("recommendations");
                                        if (recObj instanceof List<?> list) {
                                                recommendations = list.stream().map(String::valueOf).toList();
                                        } else {
                                                recommendations = List.of();
                                        }
                        AnalyticsSummary.AiHighlight.Sentiment aiSentiment = switch (sentimentStr.toUpperCase()) {
                                case "POSITIVE" -> AnalyticsSummary.AiHighlight.Sentiment.POSITIVE;
                                case "NEGATIVE" -> AnalyticsSummary.AiHighlight.Sentiment.NEGATIVE;
                                default -> sentiment;
                        };
                        return new AnalyticsSummary.AiHighlight(title, summary, aiSentiment, recommendations);
                } catch (Exception ex) {
                        log.warn("OpenAI call failed; using fallback: {}", ex.toString());
                        return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
                }
    }

                private AnalyticsSummary.AiHighlight fallbackHighlight(BigDecimal totalIncome, BigDecimal totalSpend, AnalyticsSummary.AnomalyInsight topAnomaly, AnalyticsSummary.AiHighlight.Sentiment sentiment) {
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
                                                .append(topAnomaly.amount().abs())
                                                .append("). ");
                        }
                        summary.append("Overall sentiment: ").append(sentiment.name()).append(".");

                        // Heuristic recommendations
                        List<String> recs = new java.util.ArrayList<>();
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
                                        java.util.List.copyOf(recs)
                        );
                }

        private String buildPrompt(List<Transaction> transactions,
                                                           List<AnalyticsSummary.AnomalyInsight> anomalies,
                                                           BigDecimal totalIncome,
                                                           BigDecimal totalSpend,
                                                           AnalyticsSummary.AnomalyInsight topAnomaly) {
                DateTimeFormatter dtf = DateTimeFormatter.ISO_INSTANT;
                StringBuilder sb = new StringBuilder();
                        sb.append("You are a concise financial assistant. Return ONLY compact JSON with keys: title, summary, sentiment (POSITIVE|NEUTRAL|NEGATIVE), recommendations (array of strings).\n");
                        sb.append("The 'summary' should be 3-6 sentences, actionable, and reference net flow, notable spikes, and any savings/debt guidance.\n");
                        sb.append("Base facts: totalIncome=").append(totalIncome).append(", totalSpend=").append(totalSpend).append(", net=").append(totalIncome.subtract(totalSpend)).append(".\n");
                if (topAnomaly != null) {
                        sb.append("Top anomaly: ").append(topAnomaly.merchantName()).append(", amount=").append(topAnomaly.amount().abs()).append(".\n");
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
                                .append(a.amount()).append(", score=")
                                .append(a.score()).append("\n"));
                sb.append("Respond ONLY with compact JSON, no markdown.");
                return sb.toString();
        }

        // Minimal classes to map OpenAI Responses API
        @JsonInclude(JsonInclude.Include.NON_NULL)
        public record OpenAiResponsesRequest(
                        String model,
                        List<Message> input,
                        @JsonProperty("max_output_tokens") Integer maxOutputTokens
        ) {
                public OpenAiResponsesRequest(String model, String prompt) {
                        this(model, List.of(new Message("user", prompt)), 400);
                }
        }

        public record Message(String role, String content) {}

        // OpenAI Responses API may return different shapes; we just need the top-level text
        public record OpenAiResponsesResponse(
                        String id,
                        String object,
                        Long created,
                        List<Output> output
        ) {
                public String outputText() {
                        if (output == null || output.isEmpty()) return null;
                        // find the first text type output
                        for (Output o : output) {
                                if (o.content != null) {
                                        for (OutputContent c : o.content) {
                                                if ("output_text".equals(c.type) && c.text != null) {
                                                        return c.text;
                                                }
                                        }
                                }
                        }
                        return null;
                }
        }

        public record Output(String id, String type, List<OutputContent> content) {}
        public record OutputContent(String type, String text) {}
}
