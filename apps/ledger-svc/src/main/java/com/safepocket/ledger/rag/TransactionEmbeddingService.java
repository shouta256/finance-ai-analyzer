package com.safepocket.ledger.rag;

import com.safepocket.ledger.security.RlsGuard;
import java.time.YearMonth;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionEmbeddingService {
    private static final int BACKFILL_BATCH_SIZE = 500;

    private static final Logger log = LoggerFactory.getLogger(TransactionEmbeddingService.class);

    private final RagRepository ragRepository;
    private final TxEmbeddingRepository txEmbeddingRepository;
    private final EmbeddingService embeddingService;
    private final RlsGuard rlsGuard;

    public TransactionEmbeddingService(
            RagRepository ragRepository,
            TxEmbeddingRepository txEmbeddingRepository,
            EmbeddingService embeddingService,
            RlsGuard rlsGuard
    ) {
        this.ragRepository = ragRepository;
        this.txEmbeddingRepository = txEmbeddingRepository;
        this.embeddingService = embeddingService;
        this.rlsGuard = rlsGuard;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void upsertEmbeddings(UUID userId, List<UUID> transactionIds) {
        if (transactionIds == null || transactionIds.isEmpty()) {
            return;
        }
        if (!txEmbeddingRepository.embeddingsTableExists()) {
            return;
        }
        rlsGuard.setAppsecUser(userId);
        List<RagRepository.TransactionSlice> slices = ragRepository.fetchTransactions(userId, transactionIds);
        upsertEmbeddingsFromSlices(userId, slices);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public long upsertMissingEmbeddings(UUID userId, List<UUID> transactionIds) {
        if (transactionIds == null || transactionIds.isEmpty()) {
            return 0L;
        }
        if (!txEmbeddingRepository.embeddingsTableExists()) {
            return 0L;
        }
        rlsGuard.setAppsecUser(userId);
        List<RagRepository.TransactionSlice> slices = ragRepository.fetchTransactions(userId, transactionIds);
        return upsertEmbeddingsFromSlices(userId, filterSlicesNeedingEmbeddings(userId, slices));
    }

    private long upsertEmbeddingsFromSlices(UUID userId, List<RagRepository.TransactionSlice> slices) {
        if (slices == null || slices.isEmpty()) {
            return 0L;
        }
        List<TxEmbeddingRepository.EmbeddingRecord> records = toEmbeddingRecords(userId, slices);
        if (records.isEmpty()) {
            return 0L;
        }
        txEmbeddingRepository.upsertBatch(records);
        log.debug("Upserted {} embeddings for user {}", records.size(), userId);
        return records.size();
    }

    @Transactional(readOnly = true)
    public RagReadiness readinessForUser(UUID userId) {
        boolean tableReady = txEmbeddingRepository.embeddingsTableExists();
        if (!tableReady) {
            return new RagReadiness(false, 0L, 0L);
        }
        rlsGuard.setAppsecUser(userId);
        long transactionCount = ragRepository.countTransactions(userId);
        long embeddingCount = txEmbeddingRepository.countByUserId(userId);
        return new RagReadiness(true, transactionCount, embeddingCount);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public long backfillMissingEmbeddings(UUID userId) {
        RagReadiness readiness = readinessForUser(userId);
        if (!readiness.tableReady()) {
            log.warn("Skipped RAG backfill for user {} because tx_embeddings is missing", userId);
            return 0L;
        }
        if (readiness.transactionCount() == 0 || readiness.embeddingCount() >= readiness.transactionCount()) {
            return 0L;
        }

        rlsGuard.setAppsecUser(userId);
        long upserted = 0L;
        for (int offset = 0; ; offset += BACKFILL_BATCH_SIZE) {
            List<RagRepository.TransactionSlice> slices = ragRepository.findTransactionsForEmbedding(
                    userId,
                    null,
                    null,
                    null,
                    null,
                    null,
                    BACKFILL_BATCH_SIZE,
                    offset
            );
            if (slices.isEmpty()) {
                break;
            }
            upserted += upsertEmbeddingsFromSlices(userId, filterSlicesNeedingEmbeddings(userId, slices));
            if (slices.size() < BACKFILL_BATCH_SIZE) {
                break;
            }
        }
        log.info("Backfilled {} embeddings for user {}", upserted, userId);
        return upserted;
    }

    private List<RagRepository.TransactionSlice> filterSlicesNeedingEmbeddings(
            UUID userId,
            List<RagRepository.TransactionSlice> slices
    ) {
        if (slices == null || slices.isEmpty()) {
            return List.of();
        }
        Set<UUID> existingIds = txEmbeddingRepository.findTransactionIdsWithEmbeddings(
                userId,
                slices.stream().map(RagRepository.TransactionSlice::transactionId).toList()
        );
        if (existingIds.isEmpty()) {
            return slices;
        }
        return slices.stream()
                .filter(slice -> !existingIds.contains(slice.transactionId()))
                .toList();
    }

    private List<TxEmbeddingRepository.EmbeddingRecord> toEmbeddingRecords(UUID userId, List<RagRepository.TransactionSlice> slices) {
        Map<String, float[]> embeddingsByText = new HashMap<>();
        return slices.stream()
                .map(slice -> {
                    YearMonth month = YearMonth.from(slice.occurredOn());
                    String text = buildText(slice);
                    float[] embedding = embeddingsByText.computeIfAbsent(text, embeddingService::embed);
                    return new TxEmbeddingRepository.EmbeddingRecord(
                            slice.transactionId(),
                            userId,
                            month,
                            slice.category(),
                            slice.amountCents(),
                            slice.merchantId(),
                            normalizeMerchant(slice.merchantName()),
                            embedding
                    );
                })
                .collect(Collectors.toList());
    }

    private String buildText(RagRepository.TransactionSlice slice) {
        return (slice.merchantName() + " " + slice.description()).trim();
    }

    private String normalizeMerchant(String merchantName) {
        return merchantName == null ? "" : merchantName.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
    }

    @Transactional
    public void deleteAll(UUID userId) {
        rlsGuard.setAppsecUser(userId);
        txEmbeddingRepository.deleteByUserId(userId);
        log.debug("Deleted embeddings for user {}", userId);
    }

    public record RagReadiness(boolean tableReady, long transactionCount, long embeddingCount) {
        public boolean isReady() {
            return tableReady && (transactionCount == 0 || embeddingCount >= transactionCount);
        }
    }
}
