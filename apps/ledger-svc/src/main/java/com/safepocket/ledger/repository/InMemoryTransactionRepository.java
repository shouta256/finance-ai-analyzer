package com.safepocket.ledger.repository;

import com.safepocket.ledger.model.Transaction;
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
        return storage.values().stream()
                .filter(tx -> tx.userId().equals(userId))
                .filter(tx -> YearMonth.from(tx.occurredAt().atZone(ZoneOffset.UTC)).equals(month))
                .sorted(Comparator.comparing(Transaction::occurredAt).reversed())
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId) {
        return findByUserIdAndMonth(userId, month).stream()
                .filter(tx -> tx.accountId().equals(accountId))
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public Optional<Transaction> findById(UUID transactionId) {
        return Optional.ofNullable(storage.get(transactionId));
    }
}
