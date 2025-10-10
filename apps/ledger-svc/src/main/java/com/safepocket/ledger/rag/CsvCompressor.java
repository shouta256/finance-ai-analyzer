package com.safepocket.ledger.rag;

import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Utility to compress a small window of transactions into a compact,
 * token-efficient CSV payload for LLM handoff.
 */
public final class CsvCompressor {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyMMdd");
    private static final Map<String, String> CATEGORY_SHORT_CODES = Map.ofEntries(
            Map.entry("EatingOut", "eo"),
            Map.entry("Groceries", "gr"),
            Map.entry("Transport", "tr"),
            Map.entry("Travel", "tv"),
            Map.entry("Shopping", "sh"),
            Map.entry("Entertainment", "en"),
            Map.entry("Utilities", "ut"),
            Map.entry("Housing", "ho"),
            Map.entry("Healthcare", "hc"),
            Map.entry("Transfer", "tf"),
            Map.entry("Income", "in")
    );

    private CsvCompressor() {
    }

    public static String toCsv(List<TxRow> rows) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < rows.size(); i++) {
            TxRow row = rows.get(i);
            if (i > 0) {
                sb.append('\n');
            }
            sb.append(row.txCode())
                    .append(',')
                    .append(DATE_FMT.format(row.occurredOn()))
                    .append(',')
                    .append(row.merchantCode())
                    .append(',')
                    .append(row.amountCents())
                    .append(',')
                    .append(shortCategory(row.categoryCode()));
        }
        return sb.toString();
    }

    public static String shortCategory(String category) {
        if (category == null || category.isBlank()) {
            return "ot";
        }
        String normalized = category.trim();
        String known = CATEGORY_SHORT_CODES.get(normalized);
        if (known != null) {
            return known;
        }
        // fallback: first two letters, alphanumeric only
        String letters = normalized.replaceAll("[^A-Za-z]", "").toLowerCase(Locale.ROOT);
        if (letters.length() >= 2) {
            return letters.substring(0, 2);
        }
        if (letters.length() == 1) {
            return letters + letters;
        }
        return "ot";
    }
}
