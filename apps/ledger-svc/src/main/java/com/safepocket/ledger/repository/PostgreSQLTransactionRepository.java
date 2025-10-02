package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.MerchantEntity;
import com.safepocket.ledger.entity.TransactionEntity;
import com.safepocket.ledger.model.Transaction;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Repository;

import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

@Repository
@Primary
public class PostgreSQLTransactionRepository implements TransactionRepository {

    private final JpaTransactionRepository jpaTransactionRepository;
    private final JpaMerchantRepository jpaMerchantRepository;

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
        
        List<TransactionEntity> entities = jpaTransactionRepository.findByUserIdAndMonth(userId, startOfMonth, startOfNextMonth);
        return convertToModels(entities);
    }

    @Override
    public List<Transaction> findByUserIdAndMonthAndAccount(UUID userId, YearMonth month, UUID accountId) {
        var startOfMonth = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        var startOfNextMonth = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        
        List<TransactionEntity> entities = jpaTransactionRepository.findByUserIdAndMonthAndAccount(userId, startOfMonth, startOfNextMonth, accountId);
        return convertToModels(entities);
    }

    @Override
    public Optional<Transaction> findById(UUID transactionId) {
        return jpaTransactionRepository.findById(transactionId)
                .map(this::toModel);
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
                    return toModel(entity, merchantName);
                })
                .collect(Collectors.toList());
    }

    private Transaction toModel(TransactionEntity entity) {
        // Fetch merchant name separately
        MerchantEntity merchant = jpaMerchantRepository.findById(entity.getMerchantId())
                .orElse(null);
        String merchantName = merchant != null ? merchant.getName() : "Unknown Merchant";
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
        UUID merchantId = findOrCreateMerchantByName(model.merchantName());
        
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
    
    private UUID findOrCreateMerchantByName(String merchantName) {
        // First try to find existing merchant
        List<MerchantEntity> merchants = jpaMerchantRepository.findAll();
        for (MerchantEntity merchant : merchants) {
            if (merchant.getName().equalsIgnoreCase(merchantName)) {
                return merchant.getId();
            }
        }
        
        // If not found, create new merchant
        MerchantEntity newMerchant = new MerchantEntity(
            UUID.randomUUID(),
            merchantName,
            java.time.Instant.now()
        );
        MerchantEntity savedMerchant = jpaMerchantRepository.save(newMerchant);
        return savedMerchant.getId();
    }
}