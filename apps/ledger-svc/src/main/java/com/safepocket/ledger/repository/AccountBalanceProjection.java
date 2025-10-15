package com.safepocket.ledger.repository;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Projection representing an account row with aggregated balance information.
 */
public record AccountBalanceProjection(
        UUID id,
        UUID userId,
        String name,
        String institution,
        Instant createdAt,
        BigDecimal balance,
        Instant lastTransactionAt
)
{
}
