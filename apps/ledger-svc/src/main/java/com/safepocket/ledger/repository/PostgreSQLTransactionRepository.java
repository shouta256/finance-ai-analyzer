package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.MerchantEntity;
import com.safepocket.ledger.entity.TransactionEntity;
import com.safepocket.ledger.model.Transaction;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Repository;

@Repository
@Primary
public class PostgreSQLTransactionRepository implements TransactionRepository {

    private final JpaTransactionRepository jpaTransactionRepository;
    private final JpaMerchantRepository jpaMerchantRepository;
    private final ConcurrentHashMap<String, UUID> merchantCache = new ConcurrentHashMap<>();

    public PostgreSQLTransactionRepository(JpaTransactionRepository jpaTransactionRepository,
                                         JpaMerchantRepository jpaMerchantRepository) {
        this.jpaTransactionRepository = jpaTransactionRepository;
        this.jpaMerchantRepository = jpaMerchantRepository;
    }

    @Override
    public Transaction save(Transaction transaction) {
        TransactionEntity entity = toEntity(transaction);
        TransactionEntity saved = jpaTransactionRepository.save(entity);
        return toModel(saved);
    }

    @Override
    public List<Transaction> findByUserIdAndMonth(UUID userId, YearMonth month) {
        var startOfMonth = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        var startOfNextMonth = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return findByUserIdAndRange(userId, startOfMonth, startOfNextMonth);
    }

    @Override
    public List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId) {
        var startOfMonth = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        var startOfNextMonth = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return findByUserIdAndRangeAndAccount(userId, startOfMonth, startOfNextMonth, accountId);
    }

    @Override
    public List<Transaction> findByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive) {
        List<TransactionEntity> entities = jpaTransactionRepository.findByUserIdAndRange(userId, fromInclusive, toExclusive);
        return convertToModels(entities);
    }

    @Override
    public List<Transaction> findByUserIdAndRangeAndAccount(UUID userId, Instant fromInclusive, Instant toExclusive, UUID accountId) {
        List<TransactionEntity> entities = jpaTransactionRepository.findByUserIdAndRangeAndAccount(userId, fromInclusive, toExclusive, accountId);
        return convertToModels(entities);
    }

    @Override
    public Optional<Transaction> findById(UUID transactionId) {
        return jpaTransactionRepository.findById(transactionId)
                .map(this::toModel);
    }

    @Override
    public void deleteByUserId(UUID userId) {
        jpaTransactionRepository.deleteByUserId(userId);
    }

    private List<Transaction> convertToModels(List<TransactionEntity> entities) {
        if (entities.isEmpty()) {
            return List.of();
        }

        // Get all merchant IDs from transactions
        List<UUID> merchantIds = entities.stream()
                .map(TransactionEntity::getMerchantId)
                .distinct()
                .collect(Collectors.toList());

        // Fetch all merchants in batch
        Map<UUID, MerchantEntity> merchantMap = jpaMerchantRepository.findAllById(merchantIds)
                .stream()
                .collect(Collectors.toMap(MerchantEntity::getId, Function.identity()));

        // Convert entities to models
        return entities.stream()
                .map(entity -> {
                    MerchantEntity merchant = merchantMap.get(entity.getMerchantId());
                    String merchantName = merchant != null ? merchant.getName() : "Unknown Merchant";
                    if (merchant != null) {
                        merchantCache.putIfAbsent(normalizeMerchantName(merchantName), merchant.getId());
                    }
                    return toModel(entity, merchantName);
                })
                .collect(Collectors.toList());
    }

    private Transaction toModel(TransactionEntity entity) {
        // Fetch merchant name separately
        MerchantEntity merchant = jpaMerchantRepository.findById(entity.getMerchantId())
                .orElse(null);
        String merchantName = merchant != null ? merchant.getName() : "Unknown Merchant";
        if (merchant != null) {
            merchantCache.putIfAbsent(normalizeMerchantName(merchantName), merchant.getId());
        }
        return toModel(entity, merchantName);
    }

    private Transaction toModel(TransactionEntity entity, String merchantName) {
        return new Transaction(
            entity.getId(),
            entity.getUserId(),
            entity.getAccountId(),
            merchantName,
            entity.getAmount(),
            entity.getCurrency(),
            entity.getOccurredAt(),
            entity.getAuthorizedAt(),
            entity.isPending(),
            entity.getCategory(),
            entity.getDescription(),
            Optional.empty(), // anomalyScore
            Optional.empty()  // notes
        );
    }

    private TransactionEntity toEntity(Transaction model) {
        // Find or create merchant by name
        UUID merchantId = resolveMerchantId(model.merchantName());
        
        return new TransactionEntity(
            model.id(),
            model.userId(),
            model.accountId(),
            merchantId,
            model.amount(),
            model.currency(),
            model.occurredAt(),
            model.authorizedAt(),
            model.category(),
            model.description(),
            model.pending(),
            java.time.Instant.now()
        );
    }
    
    private UUID resolveMerchantId(String merchantName) {
        String normalized = normalizeMerchantName(merchantName);
        return merchantCache.computeIfAbsent(normalized, key -> lookupOrCreateMerchant(normalized, merchantName));
    }

    private UUID lookupOrCreateMerchant(String normalized, String originalName) {
        String candidateName = originalName == null || originalName.isBlank() ? "Unknown Merchant" : originalName.trim();
        Optional<MerchantEntity> existing = jpaMerchantRepository.findByNameIgnoreCase(candidateName);
        if (existing.isPresent()) {
            return existing.get().getId();
        }
        MerchantEntity entity = new MerchantEntity(
                UUID.randomUUID(),
                candidateName,
                java.time.Instant.now()
        );
        try {
            MerchantEntity saved = jpaMerchantRepository.save(entity);
            return saved.getId();
        } catch (DataIntegrityViolationException ex) {
            return jpaMerchantRepository.findByNameIgnoreCase(candidateName)
                    .map(MerchantEntity::getId)
                    .orElseThrow(() -> ex);
        }
    }

    private String normalizeMerchantName(String merchantName) {
        if (merchantName == null) {
            return "unknown";
        }
        String trimmed = merchantName.trim().toLowerCase();
        return trimmed.isEmpty() ? "unknown" : trimmed;
    }

    @Override
    public PageResult findPageByUserIdAndRange(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId, int page, int size) {
        Pageable pageable = PageRequest.of(Math.max(page, 0), Math.max(1, size));
        Page<TransactionEntity> entityPage = accountId
                .map(uuid -> jpaTransactionRepository.findPageByUserIdAndRangeAndAccount(userId, fromInclusive, toExclusive, uuid, pageable))
                .orElseGet(() -> jpaTransactionRepository.findPageByUserIdAndRange(userId, fromInclusive, toExclusive, pageable));
        List<Transaction> models = convertToModels(entityPage.getContent());
        return new PageResult(models, entityPage.getTotalElements());
    }

    @Override
    public AggregateSnapshot loadAggregates(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId) {
        UUID accountUuid = accountId.orElse(null);
        Object[] totals = jpaTransactionRepository.totalsForRange(userId, fromInclusive, toExclusive, accountUuid);
        BigDecimal income = totals[0] instanceof BigDecimal b ? b : BigDecimal.ZERO;
        BigDecimal expense = totals[1] instanceof BigDecimal b ? b : BigDecimal.ZERO;
        long count = totals[2] instanceof Number n ? n.longValue() : 0L;
        Instant minOccurredAt = totals[3] instanceof Timestamp tsMin ? tsMin.toInstant() : null;
        Instant maxOccurredAt = totals[4] instanceof Timestamp tsMax ? tsMax.toInstant() : null;

        List<AggregateBucket> monthBuckets = jpaTransactionRepository.monthNetByRange(userId, fromInclusive, toExclusive, accountUuid)
                .stream()
                .map(row -> new AggregateBucket(formatMonthBucket(row[0]), amountOrZero(row[1])))
                .toList();
        List<AggregateBucket> dayBuckets = jpaTransactionRepository.dayNetByRange(userId, fromInclusive, toExclusive, accountUuid)
                .stream()
                .map(row -> new AggregateBucket(formatDayBucket(row[0]), amountOrZero(row[1])))
                .toList();
        List<AggregateBucket> categoryBuckets = jpaTransactionRepository.expenseByCategory(userId, fromInclusive, toExclusive, accountUuid)
                .stream()
                .map(row -> new AggregateBucket(
                        String.valueOf(row[0]),
                        amountOrZero(row[1])
                ))
                .toList();

        return new AggregateSnapshot(
                income,
                expense,
                count,
                minOccurredAt,
                maxOccurredAt,
                monthBuckets,
                dayBuckets,
                categoryBuckets
        );
    }

    private BigDecimal amountOrZero(Object value) {
        if (value instanceof BigDecimal big) {
            return big;
        }
        if (value instanceof Number number) {
            return BigDecimal.valueOf(number.doubleValue());
        }
        return BigDecimal.ZERO;
    }

    private String formatMonthBucket(Object value) {
        Instant instant = toInstant(value);
        if (instant == null) {
            return "";
        }
        YearMonth month = YearMonth.from(instant.atZone(ZoneOffset.UTC));
        return month.toString();
    }

    private String formatDayBucket(Object value) {
        Instant instant = toInstant(value);
        if (instant == null) {
            return "";
        }
        LocalDate date = instant.atZone(ZoneOffset.UTC).toLocalDate();
        return date.toString();
    }

    private Instant toInstant(Object value) {
        if (value instanceof Timestamp ts) {
            return ts.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof java.util.Date date) {
            return date.toInstant();
        }
        return null;
    }

    @Override
    public List<Transaction> findDebitTransactions(UUID userId, Instant fromInclusive, Instant toExclusive, Optional<UUID> accountId) {
        UUID accountUuid = accountId.orElse(null);
        List<TransactionEntity> entities = jpaTransactionRepository.findDebitsByUserIdAndRange(userId, fromInclusive, toExclusive, accountUuid);
        return convertToModels(entities);
    }
}
