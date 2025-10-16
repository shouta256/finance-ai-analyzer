package com.safepocket.ledger.rag;

import com.safepocket.ledger.security.RlsGuard;
import java.time.YearMonth;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionEmbeddingService {

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
        rlsGuard.setAppsecUser(userId);
        List<RagRepository.TransactionSlice> slices = ragRepository.fetchTransactions(userId, transactionIds);
        if (slices.isEmpty()) {
            return;
        }
        List<TxEmbeddingRepository.EmbeddingRecord> records = slices.stream()
                .map(slice -> {
                    YearMonth month = YearMonth.from(slice.occurredOn());
            float[] embedding = embeddingService.embed(buildText(slice));
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
        txEmbeddingRepository.upsertBatch(records);
        log.debug("Upserted {} embeddings for user {}", records.size(), userId);
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
}
