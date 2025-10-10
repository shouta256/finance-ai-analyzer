package com.safepocket.ledger.controller.dto;

import java.util.Map;

public record RagSearchResponseDto(
        String rowsCsv,
        Map<String, Map<String, String>> dict,
        StatsDto stats,
        String traceId,
        String chatId
) {
    public record StatsDto(int count, long sum, long avg) {
    }
}
