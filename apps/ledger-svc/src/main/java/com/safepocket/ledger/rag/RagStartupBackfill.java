package com.safepocket.ledger.rag;

import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "safepocket.rag.auto-backfill-on-startup", havingValue = "true")
public class RagStartupBackfill implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(RagStartupBackfill.class);

    private final RagRepository ragRepository;
    private final TransactionEmbeddingService transactionEmbeddingService;

    public RagStartupBackfill(
            RagRepository ragRepository,
            TransactionEmbeddingService transactionEmbeddingService
    ) {
        this.ragRepository = ragRepository;
        this.transactionEmbeddingService = transactionEmbeddingService;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<UUID> userIds = ragRepository.findUserIdsWithTransactions();
        if (userIds.isEmpty()) {
            log.info("RAG startup backfill skipped: no transactions found");
            return;
        }

        int usersBackfilled = 0;
        long embeddingsUpserted = 0L;
        for (UUID userId : userIds) {
            try {
                TransactionEmbeddingService.RagReadiness readiness = transactionEmbeddingService.readinessForUser(userId);
                if (!readiness.tableReady()) {
                    log.warn("RAG startup backfill skipped because tx_embeddings is missing");
                    return;
                }
                if (readiness.isReady()) {
                    continue;
                }
                embeddingsUpserted += transactionEmbeddingService.backfillMissingEmbeddings(userId);
                usersBackfilled++;
            } catch (Exception ex) {
                log.warn("RAG startup backfill failed for user {}: {}", userId, ex.getMessage());
            }
        }

        log.info(
                "RAG startup backfill completed: usersScanned={}, usersBackfilled={}, embeddingsUpserted={}",
                userIds.size(),
                usersBackfilled,
                embeddingsUpserted
        );
    }
}
