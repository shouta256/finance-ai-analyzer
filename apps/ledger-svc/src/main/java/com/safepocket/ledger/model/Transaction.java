package com.safepocket.ledger.model;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public record Transaction(
        UUID id,
        UUID userId,
        UUID accountId,
        String merchantName,
        BigDecimal amount,
        String currency,
        Instant occurredAt,
        Instant authorizedAt,
        boolean pending,
        String category,
        String description,
        Optional<AnomalyScore> anomalyScore,
        Optional<String> notes
) {
    public Transaction withCategory(String newCategory) {
        return new Transaction(
                id,
                userId,
                accountId,
                merchantName,
                amount,
                currency,
                occurredAt,
                authorizedAt,
                pending,
                newCategory,
                description,
                anomalyScore,
                notes
        );
    }

    public Transaction withAnomalyScore(AnomalyScore score) {
        return new Transaction(
                id,
                userId,
                accountId,
                merchantName,
                amount,
                currency,
                occurredAt,
                authorizedAt,
                pending,
                category,
                description,
                Optional.ofNullable(score),
                notes
        );
    }

    public Transaction withNotes(String newNotes) {
        return new Transaction(
                id,
                userId,
                accountId,
                merchantName,
                amount,
                currency,
                occurredAt,
                authorizedAt,
                pending,
                category,
                description,
                anomalyScore,
                Optional.ofNullable(newNotes)
        );
    }
}
