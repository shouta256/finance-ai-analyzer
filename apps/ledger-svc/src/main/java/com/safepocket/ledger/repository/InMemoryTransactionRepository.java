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

    @Override
    public List<Transaction> findDebitTransactions(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId) {
        return (accountId.isPresent()
                ? findByUserIdAndRangeAndAccount(userId, fromInclusive, toExclusive, accountId.get())
                : findByUserIdAndRange(userId, fromInclusive, toExclusive))
                .stream()
                .filter(tx -> tx.amount().compareTo(java.math.BigDecimal.ZERO) < 0)
                .collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public PageResult findPageByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId, int page, int size) {
        List<Transaction> filtered = (accountId.isPresent()
                ? findByUserIdAndRangeAndAccount(userId, fromInclusive, toExclusive, accountId.get())
                : findByUserIdAndRange(userId, fromInclusive, toExclusive));
        int safeSize = Math.max(1, size);
        int fromIndex = Math.max(0, page) * safeSize;
        if (fromIndex >= filtered.size()) {
            return new PageResult(List.of(), filtered.size());
        }
        int toIndex = Math.min(filtered.size(), fromIndex + safeSize);
        return new PageResult(new ArrayList<>(filtered.subList(fromIndex, toIndex)), filtered.size());
    }

    @Override
    public AggregateSnapshot loadAggregates(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId) {
        List<Transaction> transactions = accountId.isPresent()
                ? findByUserIdAndRangeAndAccount(userId, fromInclusive, toExclusive, accountId.get())
                : findByUserIdAndRange(userId, fromInclusive, toExclusive);
        if (transactions.isEmpty()) {
            return new AggregateSnapshot(
                    java.math.BigDecimal.ZERO,
                    java.math.BigDecimal.ZERO,
                    0,
                    null,
                    null,
                    List.of(),
                    List.of(),
                    List.of()
            );
        }
        java.math.BigDecimal income = java.math.BigDecimal.ZERO;
        java.math.BigDecimal expense = java.math.BigDecimal.ZERO;
        java.time.Instant min = null;
        java.time.Instant max = null;
        Map<String, java.math.BigDecimal> monthBuckets = new ConcurrentHashMap<>();
        Map<String, java.math.BigDecimal> dayBuckets = new ConcurrentHashMap<>();
        Map<String, java.math.BigDecimal> categoryBuckets = new ConcurrentHashMap<>();
        for (Transaction tx : transactions) {
            java.math.BigDecimal amount = tx.amount();
            if (amount.compareTo(java.math.BigDecimal.ZERO) > 0) {
                income = income.add(amount);
            } else {
                expense = expense.add(amount);
                String category = tx.category() == null || tx.category().isBlank() ? "Uncategorised" : tx.category();
                categoryBuckets.merge(category, amount, java.math.BigDecimal::add);
            }
            java.time.Instant occurred = tx.occurredAt();
            min = (min == null || occurred.isBefore(min)) ? occurred : min;
            max = (max == null || occurred.isAfter(max)) ? occurred : max;
            java.time.LocalDate date = occurred.atZone(ZoneOffset.UTC).toLocalDate();
            String monthKey = YearMonth.from(date).toString();
            String dayKey = date.toString();
            monthBuckets.merge(monthKey, amount, java.math.BigDecimal::add);
            dayBuckets.merge(dayKey, amount, java.math.BigDecimal::add);
        }
        List<AggregateBucket> month = monthBuckets.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> new AggregateBucket(e.getKey(), e.getValue()))
                .toList();
        List<AggregateBucket> day = dayBuckets.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> new AggregateBucket(e.getKey(), e.getValue()))
                .toList();
        List<AggregateBucket> categories = categoryBuckets.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> new AggregateBucket(e.getKey(), e.getValue()))
                .toList();
        return new AggregateSnapshot(
                income,
                expense,
                transactions.size(),
                min,
                max,
                month,
                day,
                categories
        );
    }
}
