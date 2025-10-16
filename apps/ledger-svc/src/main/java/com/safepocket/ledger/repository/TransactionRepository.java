package com.safepocket.ledger.repository;

import com.safepocket.ledger.model.Transaction;
import java.time.Instant;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TransactionRepository {
    Transaction save(Transaction transaction);

    List<Transaction> findByUserIdAndMonth(UUID userId, YearMonth month);

    List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId);

    List<Transaction> findByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive);

    List<Transaction> findByUserIdAndRangeAndAccount(UUID userId, Instant fromInclusive, Instant toExclusive, UUID accountId);

    Optional<Transaction> findById(UUID transactionId);

    void deleteByUserId(UUID userId);
}
