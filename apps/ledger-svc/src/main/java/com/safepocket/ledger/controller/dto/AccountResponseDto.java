package com.safepocket.ledger.controller.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record AccountResponseDto(
        UUID id,
        String name,
        String institution,
        String type,
        BigDecimal balance,
        String currency,
        Instant createdAt,
        Instant lastTransactionAt,
        Instant linkedAt
) {
}
