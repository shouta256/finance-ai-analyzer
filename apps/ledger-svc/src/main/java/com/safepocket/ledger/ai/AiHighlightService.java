package com.safepocket.ledger.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.format.DateTimeFormatter;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class AiHighlightService {

    private static final Logger log = LoggerFactory.getLogger(AiHighlightService.class);

    private final OpenAiResponsesClient openAiClient;
    private final ObjectMapper objectMapper;
    private final AiHighlightRepository highlightRepository;

    public AiHighlightService(OpenAiResponsesClient openAiClient, ObjectMapper objectMapper, AiHighlightRepository highlightRepository) {
        this.openAiClient = openAiClient;
        this.objectMapper = objectMapper;
        this.highlightRepository = highlightRepository;
    }

    public AnalyticsSummary.AiHighlight generateHighlight(
            UUID userId,
            java.time.YearMonth month,
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

        Optional<AiMonthlyHighlightEntity> existingEntity = highlightRepository.findByUserIdAndMonth(userId, month.toString());
        AnalyticsSummary.AiHighlight existingHighlight = existingEntity.map(this::toHighlight).orElse(null);

        String fingerprint = computeFingerprint(transactions, anomalies);
        if (existingHighlight != null) {
            String storedFingerprint = existingEntity.map(AiMonthlyHighlightEntity::getFingerprint).orElse(null);
            if (storedFingerprint != null && storedFingerprint.equals(fingerprint)) {
                return existingHighlight;
            }
        }

        if (!generateAi || !openAiClient.hasCredentials()) {
            if (existingHighlight != null) {
                return existingHighlight;
            }
            return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
        }

        String prompt = buildPrompt(transactions, anomalies, totalIncome, totalSpend, topAnomaly);
        AnalyticsSummary.AiHighlight highlight;
        boolean aiGenerated = false;
        try {
            Optional<String> aiResponse = openAiClient.generateText(
                    List.of(new OpenAiResponsesClient.Message("user", prompt)),
                    700);
            if (aiResponse.isPresent()) {
                highlight = buildHighlightFromResponse(aiResponse.get(), totalIncome, totalSpend, topAnomaly, sentiment);
                aiGenerated = true;
            } else {
                log.warn("AI highlight: OpenAI response missing, using fallback");
                highlight = fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
            }
        } catch (Exception ex) {
            log.warn("AI highlight: failed to generate highlight, using fallback", ex);
            highlight = fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
        }

        if (aiGenerated) {
            saveHighlight(userId, month, highlight, fingerprint);
        }

        return highlight;
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
            AnalyticsSummary.AiHighlight loose = tryLooseParse(normalized, totalIncome, totalSpend, topAnomaly, sentiment);
            if (loose != null) {
                return loose;
            }
            log.warn("AI highlight: failed to parse response '{}', falling back", normalized);
            return fallbackHighlight(totalIncome, totalSpend, topAnomaly, sentiment);
        }
    }

    public Optional<AnalyticsSummary.HighlightSnapshot> latestHighlight(UUID userId) {
        return highlightRepository.findFirstByUserIdOrderByMonthDesc(userId)
                .map(this::toSnapshot);
    }

    private void saveHighlight(UUID userId, YearMonth month, AnalyticsSummary.AiHighlight highlight, String fingerprint) {
        String recommendations = String.join("\n", highlight.recommendations());
        AiMonthlyHighlightEntity entity = highlightRepository.findByUserIdAndMonth(userId, month.toString())
                .orElse(new AiMonthlyHighlightEntity(userId, month.toString(), highlight.title(), highlight.summary(), highlight.sentiment().name(), recommendations));
        entity.setMonth(month.toString());
        entity.setTitle(highlight.title());
        entity.setSummary(highlight.summary());
        entity.setSentiment(highlight.sentiment().name());
        entity.setRecommendations(recommendations);
        entity.setFingerprint(fingerprint);
        highlightRepository.save(entity);
    }

    private AnalyticsSummary.HighlightSnapshot toSnapshot(AiMonthlyHighlightEntity entity) {
        return new AnalyticsSummary.HighlightSnapshot(
                YearMonth.parse(entity.getMonth()),
                toHighlight(entity)
        );
    }

    private AnalyticsSummary.AiHighlight toHighlight(AiMonthlyHighlightEntity entity) {
        return new AnalyticsSummary.AiHighlight(
                entity.getTitle(),
                entity.getSummary(),
                AnalyticsSummary.AiHighlight.Sentiment.valueOf(entity.getSentiment()),
                parseRecommendations(entity.getRecommendations()));
    }

    private List<String> parseRecommendations(String stored) {
        if (stored == null || stored.isBlank()) {
            return List.of();
        }
        return List.of(stored.split("\n"));
    }

    private List<String> extractRecommendations(Object recObj) {
        if (recObj instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        return List.of();
    }

    private AnalyticsSummary.AiHighlight tryLooseParse(
            String text,
            BigDecimal totalIncome,
            BigDecimal totalSpend,
            AnalyticsSummary.AnomalyInsight topAnomaly,
            AnalyticsSummary.AiHighlight.Sentiment defaultSentiment) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String s = text.trim();
        if (s.startsWith("```")) {
            int firstNl = s.indexOf('\n');
            if (firstNl > 0) s = s.substring(firstNl + 1);
            int fence = s.lastIndexOf("```");
            if (fence > 0) s = s.substring(0, fence);
            s = s.trim();
        }
        int firstBrace = s.indexOf('{');
        int lastBrace = s.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            String candidate = s.substring(firstBrace, lastBrace + 1);
            try {
                Map<String, Object> ai = objectMapper.readValue(candidate, new TypeReference<Map<String, Object>>() {});
                String title = ai.get("title") != null ? String.valueOf(ai.get("title")) : "Monthly financial health";
                String summary = ai.get("summary") != null ? String.valueOf(ai.get("summary")) : "";
                String sentimentStr = ai.get("sentiment") != null ? String.valueOf(ai.get("sentiment")) : defaultSentiment.name();
                List<String> recommendations = extractRecommendations(ai.get("recommendations"));
                AnalyticsSummary.AiHighlight.Sentiment aiSentiment = switch (sentimentStr.toUpperCase()) {
                    case "POSITIVE" -> AnalyticsSummary.AiHighlight.Sentiment.POSITIVE;
                    case "NEGATIVE" -> AnalyticsSummary.AiHighlight.Sentiment.NEGATIVE;
                    default -> defaultSentiment;
                };
                return new AnalyticsSummary.AiHighlight(title, summary, aiSentiment, recommendations);
            } catch (Exception ignore) {
                // fall through to regex-based salvage
            }
        }
        String title = matchFirstGroup(s, "\\\"title\\\"\\s*:\\s*\\\"(.*?)\\\"");
        String summary = matchFirstGroup(s, "\\\"summary\\\"\\s*:\\s*\\\"(.*?)\\\"");
        String sentimentStr = matchFirstGroup(s, "\\\"sentiment\\\"\\s*:\\s*\\\"(POSITIVE|NEUTRAL|NEGATIVE)\\\"");
        List<String> recs = matchAllGroups(s, "\\\"recommendations\\\"[\\s\\S]*?\\[(.*?)\\]", "\\\"(.*?)\\\"");
        if (title != null || summary != null || sentimentStr != null || !recs.isEmpty()) {
            AnalyticsSummary.AiHighlight.Sentiment aiSentiment = switch (sentimentStr != null ? sentimentStr.toUpperCase() : "") {
                case "POSITIVE" -> AnalyticsSummary.AiHighlight.Sentiment.POSITIVE;
                case "NEGATIVE" -> AnalyticsSummary.AiHighlight.Sentiment.NEGATIVE;
                case "NEUTRAL" -> AnalyticsSummary.AiHighlight.Sentiment.NEUTRAL;
                default -> defaultSentiment;
            };
            return new AnalyticsSummary.AiHighlight(
                    title != null ? title : "Monthly financial health",
                    summary != null ? summary : "",
                    aiSentiment,
                    recs.isEmpty() ? List.of() : recs
            );
        }
        return null;
    }

    private String matchFirstGroup(String text, String pattern) {
        try {
            java.util.regex.Pattern p = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE);
            java.util.regex.Matcher m = p.matcher(text);
            if (m.find()) return m.group(1);
        } catch (Exception ignored) {}
        return null;
    }

    private List<String> matchAllGroups(String text, String outerPattern, String innerQuotedPattern) {
        try {
            java.util.regex.Pattern outer = java.util.regex.Pattern.compile(outerPattern, java.util.regex.Pattern.CASE_INSENSITIVE);
            java.util.regex.Matcher mo = outer.matcher(text);
            if (mo.find()) {
                String inside = mo.group(1);
                java.util.regex.Pattern inner = java.util.regex.Pattern.compile(innerQuotedPattern);
                java.util.regex.Matcher mi = inner.matcher(inside);
                List<String> out = new ArrayList<>();
                while (mi.find()) {
                    out.add(mi.group(1));
                    if (out.size() >= 8) break;
                }
                return out;
            }
        } catch (Exception ignored) {}
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
                .append(" and spend $")
                .append(totalSpend)
                .append(" give net $")
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
            recs.add("Net negative this month. Review the top three expense categories and delay optional costs.");
        } else if (net.compareTo(BigDecimal.ZERO) > 0) {
            recs.add("Net positive. Move 10-20% to savings or pay extra on debt.");
        } else {
            recs.add("Inflow and outflow are balanced. Check upcoming recurring bills.");
        }
        if (topAnomaly != null && topAnomaly.amount().abs().compareTo(new BigDecimal("500")) > 0) {
            recs.add("Check the large charge at " + topAnomaly.merchantName() + " and set a spending alert.");
        }
        recs.add("Plan a budget review and adjust category limits.");

        return new AnalyticsSummary.AiHighlight(
                "Monthly financial health",
                summary.toString(),
                sentiment,
                List.copyOf(recs));
    }

    private String computeFingerprint(List<Transaction> transactions, List<AnalyticsSummary.AnomalyInsight> anomalies) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            updateDigest(digest, "txCount:" + transactions.size());
            transactions.stream()
                    .sorted(Comparator.comparing(Transaction::id))
                    .forEach(tx -> {
                        updateDigest(digest, tx.id() != null ? tx.id().toString() : "");
                        updateDigest(digest, tx.amount() != null ? tx.amount().setScale(2, RoundingMode.HALF_UP).toPlainString() : "0");
                        updateDigest(digest, tx.category());
                        updateDigest(digest, tx.merchantName());
                        updateDigest(digest, tx.occurredAt() != null ? tx.occurredAt().toString() : "");
                        updateDigest(digest, tx.pending() ? "1" : "0");
                    });
            updateDigest(digest, "anomalyCount:" + anomalies.size());
            anomalies.stream()
                    .sorted(Comparator.comparing(AnalyticsSummary.AnomalyInsight::transactionId, Comparator.nullsLast(String::compareTo)))
                    .forEach(anomaly -> {
                        updateDigest(digest, anomaly.transactionId());
                        updateDigest(digest, anomaly.method() != null ? anomaly.method().name() : "");
                        updateDigest(digest, anomaly.amount() != null ? anomaly.amount().setScale(2, RoundingMode.HALF_UP).toPlainString() : "0");
                        updateDigest(digest, anomaly.deltaAmount() != null ? anomaly.deltaAmount().setScale(2, RoundingMode.HALF_UP).toPlainString() : "0");
                        updateDigest(digest, anomaly.budgetImpactPercent() != null ? anomaly.budgetImpactPercent().setScale(2, RoundingMode.HALF_UP).toPlainString() : "0");
                    });
            byte[] hash = digest.digest();
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 digest unavailable", ex);
        }
    }

    private void updateDigest(MessageDigest digest, String value) {
        if (value == null) {
            digest.update((byte) 0);
        } else {
            digest.update(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String buildPrompt(
            List<Transaction> transactions,
            List<AnalyticsSummary.AnomalyInsight> anomalies,
            BigDecimal totalIncome,
            BigDecimal totalSpend,
            AnalyticsSummary.AnomalyInsight topAnomaly) {
        DateTimeFormatter dtf = DateTimeFormatter.ISO_INSTANT;
        StringBuilder sb = new StringBuilder();
        sb.append("You are a simple money helper. Reply with compact JSON. Keys: title, summary, sentiment (POSITIVE|NEUTRAL|NEGATIVE), recommendations (list of strings).\n");
        sb.append("Use easy English with US dollars. Summary must mention net cash flow, big spikes, and one or two tips.\n");
        sb.append("Base facts (USD): income=$").append(totalIncome)
                .append(", spend=$").append(totalSpend)
                .append(", net=$").append(totalIncome.subtract(totalSpend)).append(".\n");
        if (topAnomaly != null) {
            sb.append("Top anomaly: ").append(topAnomaly.merchantName()).append(", amount=$")
                    .append(topAnomaly.amount().abs()).append(".\n");
        }
        sb.append("Transactions (max 20 lines):\n");
        transactions.stream().limit(20).forEach(t -> sb.append("- ")
                .append(dtf.format(t.occurredAt())).append(" ")
                .append(t.merchantName()).append(": ")
                .append("$").append(t.amount()).append(" ")
                .append(t.category()).append("\n"));
        sb.append("Anomalies (top 5):\n");
        anomalies.stream().limit(5).forEach(a -> sb.append("- ")
                .append(a.merchantName()).append(": ")
                .append("$").append(a.amount()).append(", delta=$")
                .append(Optional.ofNullable(a.deltaAmount()).orElse(BigDecimal.ZERO)).append(", budgetImpact=")
                .append(Optional.ofNullable(a.budgetImpactPercent()).orElse(BigDecimal.ZERO)).append("%\n"));
        sb.append("Answer with compact JSON only. Do not use markdown.");
        return sb.toString();
    }
}
