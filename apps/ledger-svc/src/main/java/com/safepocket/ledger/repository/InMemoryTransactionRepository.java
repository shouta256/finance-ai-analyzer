package com.safepocket.ledger.repository;

import com.safepocket.ledger.model.Transaction;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import org.springframework.stereotype.Repository;

@Repository
public class InMemoryTransactionRepository implements TransactionRepository {

    private final Map<UUID, Transaction> storage = new ConcurrentHashMap<>();

    @Override
    public Transaction save(Transaction transaction) {
        storage.put(transaction.id(), transaction);
        return transaction;
    }

    @Override
    public List<Transaction> findByUserIdAndMonth(UUID userId, YearMonth month) {
        var start = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        var end = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return findByUserIdAndRange(userId, start, end);
    }

    @Override
    public List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId) {
        var start = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        var end = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return findByUserIdAndRangeAndAccount(userId, start, end, accountId);
    }

    @Override
    public List<Transaction> findByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive) {
        return storage.values().stream()
                .filter(tx -> tx.userId().equals(userId))
                .filter(tx -> !tx.occurredAt().isBefore(fromInclusive) && tx.occurredAt().isBefore(toExclusive))
                .sorted(Comparator.comparing(Transaction::occurredAt).reversed())
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public List<Transaction> findByUserIdAndRangeAndAccount(UUID userId, Instant fromInclusive, Instant toExclusive, UUID accountId) {
        return findByUserIdAndRange(userId, fromInclusive, toExclusive).stream()
                .filter(tx -> tx.accountId().equals(accountId))
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public Optional<Transaction> findById(UUID transactionId) {
        return Optional.ofNullable(storage.get(transactionId));
    }

    @Override
    public void deleteByUserId(UUID userId) {
        storage.entrySet().removeIf(entry -> entry.getValue().userId().equals(userId));
    }
}
