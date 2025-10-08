package com.safepocket.ledger.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.time.Instant;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record TransactionResponseDto(
        String id,
        String userId,
        String accountId,
        String merchantName,
        BigDecimal amount,
        String currency,
        Instant occurredAt,
        Instant authorizedAt,
        boolean pending,
        String category,
        String description,
        AnomalyScoreDto anomalyScore,
        String notes
) {
    public record AnomalyScoreDto(String method, BigDecimal deltaAmount, BigDecimal budgetImpactPercent, String commentary) {
    }
}
