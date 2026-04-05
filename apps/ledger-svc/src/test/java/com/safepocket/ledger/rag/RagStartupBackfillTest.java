package com.safepocket.ledger.rag;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.boot.ApplicationArguments;

@ExtendWith(MockitoExtension.class)
class RagStartupBackfillTest {

    @Mock
    RagRepository ragRepository;

    @Mock
    TransactionEmbeddingService transactionEmbeddingService;

    RagStartupBackfill ragStartupBackfill;

    @BeforeEach
    void setUp() {
        ragStartupBackfill = new RagStartupBackfill(ragRepository, transactionEmbeddingService);
    }

    @Test
    void backfillsOnlyUsersMissingEmbeddings() throws Exception {
        UUID readyUser = UUID.randomUUID();
        UUID staleUser = UUID.randomUUID();

        when(ragRepository.findUserIdsWithTransactions()).thenReturn(List.of(readyUser, staleUser));
        when(transactionEmbeddingService.readinessForUser(readyUser))
                .thenReturn(new TransactionEmbeddingService.RagReadiness(true, 4L, 4L));
        when(transactionEmbeddingService.readinessForUser(staleUser))
                .thenReturn(new TransactionEmbeddingService.RagReadiness(true, 4L, 0L));
        when(transactionEmbeddingService.backfillMissingEmbeddings(staleUser)).thenReturn(4L);

        ragStartupBackfill.run(mock(ApplicationArguments.class));

        verify(transactionEmbeddingService, never()).backfillMissingEmbeddings(readyUser);
        verify(transactionEmbeddingService).backfillMissingEmbeddings(staleUser);
    }

    @Test
    void skipsWhenEmbeddingsTableIsMissing() throws Exception {
        UUID userId = UUID.randomUUID();

        when(ragRepository.findUserIdsWithTransactions()).thenReturn(List.of(userId));
        when(transactionEmbeddingService.readinessForUser(userId))
                .thenReturn(new TransactionEmbeddingService.RagReadiness(false, 0L, 0L));

        ragStartupBackfill.run(mock(ApplicationArguments.class));

        verify(transactionEmbeddingService, never()).backfillMissingEmbeddings(userId);
    }
}
