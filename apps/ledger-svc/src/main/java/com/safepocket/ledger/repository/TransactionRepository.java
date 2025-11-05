package com.safepocket.ledger.repository;

import com.safepocket.ledger.model.Transaction;
import java.time.Instant;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TransactionRepository {
    record PageResult(List<Transaction> transactions, long totalElements) {}

    record AggregateBucket(String key, java.math.BigDecimal amount) {}

    record AggregateSnapshot(
            java.math.BigDecimal incomeTotal,
            java.math.BigDecimal expenseTotal,
            long count,
            java.time.Instant minOccurredAt,
            java.time.Instant maxOccurredAt,
            List<AggregateBucket> monthBuckets,
            List<AggregateBucket> dayBuckets,
            List<AggregateBucket> categoryBuckets
    ) {}

    Transaction save(Transaction transaction);

    List<Transaction> findByUserIdAndMonth(UUID userId, YearMonth month);

    List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId);

    List<Transaction> findByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive);

    List<Transaction> findByUserIdAndRangeAndAccount(UUID userId, Instant fromInclusive, Instant toExclusive, UUID accountId);

    Optional<Transaction> findById(UUID transactionId);

    void deleteByUserId(UUID userId);

    List<Transaction> findDebitTransactions(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId);

    PageResult findPageByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId, int page, int size);

    AggregateSnapshot loadAggregates(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId);
}
