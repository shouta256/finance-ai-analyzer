package com.safepocket.ledger.rag;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * Lightweight masker that redacts common PII patterns before returning payloads to LLMs/tools.
 */
public final class PiiMasker {

    private static final Pattern ACCOUNT_PATTERN = Pattern.compile("\\b\\d{10,}\\b");
    private static final Pattern PHONE_PATTERN = Pattern.compile("\\b(?:\\+?\\d{1,3}[\\s-]?)?(\\d{3})[\\s-]?(\\d{3,4})[\\s-]?(\\d{4})\\b");
    private static final Pattern ADDRESS_PATTERN = Pattern.compile("\\b\\d+\\s+[A-Za-z]{2,}[^,\\n]{2,}");

    private PiiMasker() {
    }

    public static String mask(String input) {
        if (input == null || input.isBlank()) {
            return input;
        }
        String value = ACCOUNT_PATTERN.matcher(input).replaceAll("***");
        value = PHONE_PATTERN.matcher(value).replaceAll("***-****-****");
        value = ADDRESS_PATTERN.matcher(value).replaceAll("***");
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> maskDeep(Map<String, Object> payload) {
        if (payload == null) {
            return null;
        }
        for (Map.Entry<String, Object> entry : payload.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String str) {
                entry.setValue(mask(str));
            } else if (value instanceof Map<?, ?> nested) {
                entry.setValue(maskDeep((Map<String, Object>) nested));
            }
        }
        return payload;
    }
}
