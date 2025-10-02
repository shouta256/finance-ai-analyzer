package com.safepocket.ledger.analytics;

import static org.assertj.core.api.Assertions.assertThat;

import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class AnomalyDetectionServiceTest {

    private final AnomalyDetectionService service = new AnomalyDetectionService();

    @Test
    void detectsHighSpendOutlier() {
        UUID userId = UUID.randomUUID();
        UUID accountId = UUID.randomUUID();
        List<Transaction> transactions = List.of(
                transaction(userId, accountId, "Coffee", BigDecimal.valueOf(-5.25), Instant.parse("2024-03-01T10:00:00Z")),
                transaction(userId, accountId, "Groceries", BigDecimal.valueOf(-80.10), Instant.parse("2024-03-02T10:00:00Z")),
                transaction(userId, accountId, "Utilities", BigDecimal.valueOf(-120.00), Instant.parse("2024-03-03T10:00:00Z")),
                transaction(userId, accountId, "Laptop", BigDecimal.valueOf(-2100.99), Instant.parse("2024-03-04T10:00:00Z"))
        );

        var anomalies = service.detectAnomalies(transactions);

        assertThat(anomalies)
                .hasSize(1)
                .first()
                .satisfies(anomaly -> {
                    assertThat(anomaly.transactionId()).isNotBlank();
                    assertThat(anomaly.merchantName()).isEqualTo("Laptop");
                });
    }

    private Transaction transaction(UUID userId, UUID accountId, String merchant, BigDecimal amount, Instant occurredAt) {
        return new Transaction(
                UUID.randomUUID(),
                userId,
                accountId,
                merchant,
                amount,
                "USD",
                occurredAt,
                occurredAt,
                false,
                "Misc",
                merchant,
                Optional.empty(),
                Optional.empty()
        );
    }
}
