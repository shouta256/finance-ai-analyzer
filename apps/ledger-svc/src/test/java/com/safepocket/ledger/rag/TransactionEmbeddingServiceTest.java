package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.Set;
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
        when(txEmbeddingRepository.findTransactionIdsWithEmbeddings(userId, List.of(slice.transactionId())))
                .thenReturn(Set.of());
        when(ragRepository.findTransactionsForEmbedding(userId, null, null, null, null, null, 500, 0))
                .thenReturn(List.of(slice));
        when(embeddingService.embed("Starbucks Coffee")).thenReturn(new float[] {0.1f, 0.2f});

        long upserted = service.backfillMissingEmbeddings(userId);

        assertThat(upserted).isEqualTo(1L);
        verify(txEmbeddingRepository).upsertBatch(anyList());
        verify(ragRepository).findTransactionsForEmbedding(userId, null, null, null, null, null, 500, 0);
    }

    @Test
    void backfillMissingEmbeddingsSkipsTransactionsThatAlreadyHaveEmbeddings() {
        UUID userId = UUID.randomUUID();
        UUID existingTxId = UUID.randomUUID();
        UUID missingTxId = UUID.randomUUID();
        UUID merchantId = UUID.randomUUID();
        RagRepository.TransactionSlice existing = new RagRepository.TransactionSlice(
                existingTxId,
                LocalDate.of(2026, 4, 5),
                1250,
                "Dining",
                "Coffee",
                merchantId,
                "Starbucks"
        );
        RagRepository.TransactionSlice missing = new RagRepository.TransactionSlice(
                missingTxId,
                LocalDate.of(2026, 4, 6),
                980,
                "Dining",
                "Coffee",
                merchantId,
                "Blue Bottle"
        );

        when(txEmbeddingRepository.embeddingsTableExists()).thenReturn(true);
        when(ragRepository.countTransactions(userId)).thenReturn(2L);
        when(txEmbeddingRepository.countByUserId(userId)).thenReturn(1L);
        when(ragRepository.findTransactionsForEmbedding(userId, null, null, null, null, null, 500, 0))
                .thenReturn(List.of(existing, missing));
        when(txEmbeddingRepository.findTransactionIdsWithEmbeddings(userId, List.of(existingTxId, missingTxId)))
                .thenReturn(Set.of(existingTxId));
        when(embeddingService.embed("Blue Bottle Coffee")).thenReturn(new float[] {0.4f, 0.8f});

        long upserted = service.backfillMissingEmbeddings(userId);

        assertThat(upserted).isEqualTo(1L);
        verify(embeddingService).embed("Blue Bottle Coffee");
        verify(embeddingService, never()).embed("Starbucks Coffee");
        verify(txEmbeddingRepository).upsertBatch(anyList());
    }

    @Test
    void upsertEmbeddingsReusesIdenticalTextsWithinBatch() {
        UUID userId = UUID.randomUUID();
        UUID merchantId = UUID.randomUUID();
        RagRepository.TransactionSlice first = new RagRepository.TransactionSlice(
                UUID.randomUUID(),
                LocalDate.of(2026, 4, 5),
                1250,
                "Dining",
                "Coffee",
                merchantId,
                "Starbucks"
        );
        RagRepository.TransactionSlice second = new RagRepository.TransactionSlice(
                UUID.randomUUID(),
                LocalDate.of(2026, 4, 6),
                990,
                "Dining",
                "Coffee",
                merchantId,
                "Starbucks"
        );

        when(txEmbeddingRepository.embeddingsTableExists()).thenReturn(true);
        when(ragRepository.fetchTransactions(userId, List.of(first.transactionId(), second.transactionId())))
                .thenReturn(List.of(first, second));
        when(embeddingService.embed("Starbucks Coffee")).thenReturn(new float[] {0.1f, 0.2f});

        service.upsertEmbeddings(userId, List.of(first.transactionId(), second.transactionId()));

        verify(embeddingService).embed("Starbucks Coffee");
        verify(txEmbeddingRepository).upsertBatch(anyList());
    }
}
