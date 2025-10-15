package com.safepocket.ledger.model;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public record AccountSummary(
        UUID id,
        UUID userId,
        String name,
        String institution,
        Optional<String> type,
        BigDecimal balance,
        String currency,
        Instant createdAt,
        Optional<Instant> lastTransactionAt,
        Optional<Instant> linkedAt
) {
}
