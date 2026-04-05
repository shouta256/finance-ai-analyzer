package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class TransactionEmbeddingServiceTest {

    @Mock
    RagRepository ragRepository;

    @Mock
    TxEmbeddingRepository txEmbeddingRepository;

    @Mock
    EmbeddingService embeddingService;

    @Mock
    com.safepocket.ledger.security.RlsGuard rlsGuard;

    TransactionEmbeddingService service;

    @BeforeEach
    void setUp() {
        service = new TransactionEmbeddingService(ragRepository, txEmbeddingRepository, embeddingService, rlsGuard);
    }

    @Test
    void readinessIsNotReadyWhenEmbeddingsTableIsMissing() {
        UUID userId = UUID.randomUUID();
        when(txEmbeddingRepository.embeddingsTableExists()).thenReturn(false);

        TransactionEmbeddingService.RagReadiness readiness = service.readinessForUser(userId);

        assertThat(readiness.tableReady()).isFalse();
        assertThat(readiness.isReady()).isFalse();
        assertThat(readiness.transactionCount()).isZero();
        assertThat(readiness.embeddingCount()).isZero();
    }

    @Test
    void backfillMissingEmbeddingsUpsertsExistingTransactions() {
        UUID userId = UUID.randomUUID();
        UUID merchantId = UUID.randomUUID();
        RagRepository.TransactionSlice slice = new RagRepository.TransactionSlice(
                UUID.randomUUID(),
                LocalDate.of(2026, 4, 5),
                1250,
                "Dining",
                "Coffee",
                merchantId,
                "Starbucks"
        );

        when(txEmbeddingRepository.embeddingsTableExists()).thenReturn(true);
        when(ragRepository.countTransactions(userId)).thenReturn(1L);
        when(txEmbeddingRepository.countByUserId(userId)).thenReturn(0L);
        when(ragRepository.findTransactionsForEmbedding(userId, null, null, null, null, null, 500, 0))
                .thenReturn(List.of(slice));
        when(embeddingService.embed("Starbucks Coffee")).thenReturn(new float[] {0.1f, 0.2f});

        long upserted = service.backfillMissingEmbeddings(userId);

        assertThat(upserted).isEqualTo(1L);
        verify(txEmbeddingRepository).upsertBatch(anyList());
        verify(ragRepository).findTransactionsForEmbedding(userId, null, null, null, null, null, 500, 0);
    }
}
