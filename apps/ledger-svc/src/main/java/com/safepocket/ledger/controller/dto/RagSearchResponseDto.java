package com.safepocket.ledger.controller.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record RagSearchResponseDto(
        String rowsCsv,
        Map<String, Map<String, String>> dict,
        StatsDto stats,
        List<ReferenceDto> references,
        String traceId,
        String chatId
) {
    public record StatsDto(int count, long sum, long avg) {
    }

    public record ReferenceDto(
            String txCode,
            UUID transactionId,
            LocalDate occurredOn,
            String merchant,
            int amountCents,
            String category,
            double score,
            List<String> matchedTerms,
            List<String> reasons
    ) {
    }
}
