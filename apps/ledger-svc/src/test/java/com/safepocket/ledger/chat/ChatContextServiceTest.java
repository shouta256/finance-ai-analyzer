package com.safepocket.ledger.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.rag.TransactionEmbeddingService;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ChatContextServiceTest {

    @Mock
    RagService ragService;

    @Mock
    TransactionEmbeddingService transactionEmbeddingService;

    ChatContextService chatContextService;

    @BeforeEach
    void setUp() {
        chatContextService = new ChatContextService(
                ragService,
                transactionEmbeddingService,
                new ObjectMapper().findAndRegisterModules()
        );
    }

    @Test
    void greetingDoesNotTriggerRetrieval() {
        ChatContextService.ChatContextBundle bundle = chatContextService.buildContextBundle(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "hello"
        );

        assertThat(bundle.sources()).isEmpty();
        assertThat(bundle.contextJson()).contains("GREETING");
        verify(ragService, never()).search(any(), any());
        verify(ragService, never()).summaries(any());
    }

    @Test
    void outOfScopeQuestionDoesNotTriggerRetrieval() {
        ChatContextService.ChatContextBundle bundle = chatContextService.buildContextBundle(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "is cat an animal"
        );

        assertThat(bundle.sources()).isEmpty();
        assertThat(bundle.contextJson()).contains("OUT_OF_SCOPE");
        verify(ragService, never()).search(any(), any());
        verify(ragService, never()).summaries(any());
    }

    @Test
    void summaryQuestionUsesSummaryWithoutRetrievalSources() {
        when(ragService.summaries(any())).thenReturn(new RagService.SummariesResponse(
                "2026-04",
                new RagService.Totals(840625, -1257723, -417098),
                List.of(),
                List.of(),
                "trace-1"
        ));

        ChatContextService.ChatContextBundle bundle = chatContextService.buildContextBundle(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "give me a summary of this month"
        );

        assertThat(bundle.sources()).isEmpty();
        assertThat(bundle.contextJson()).contains("SUMMARY_ONLY");
        assertThat(bundle.contextJson()).contains("incomeCents");
        verify(ragService).summaries(any());
        verify(ragService, never()).search(any(), any());
    }

    @Test
    void transactionQuestionUsesRetrievalSources() {
        UUID txId = UUID.fromString("33333333-3333-3333-3333-333333333333");
        when(ragService.summaries(any())).thenReturn(new RagService.SummariesResponse(
                "2026-04",
                new RagService.Totals(840625, -1257723, -417098),
                List.of(),
                List.of(),
                "trace-1"
        ));
        when(ragService.search(any(), any())).thenReturn(new RagService.SearchResponse(
                "t33333333,260401,m1,-875,di",
                Map.of("merchants", Map.of("m1", "Starbucks"), "categories", Map.of("di", "Dining")),
                new RagService.Stats(1, -875, -875),
                List.of(new RagService.SearchReference(
                        "t33333333",
                        txId,
                        LocalDate.of(2026, 4, 1),
                        "Starbucks",
                        -875,
                        "Dining",
                        0.81,
                        List.of("coffee"),
                        List.of("matched terms: coffee", "semantic similarity")
                )),
                "trace-2",
                "chat-1"
        ));

        ChatContextService.ChatContextBundle bundle = chatContextService.buildContextBundle(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "how much did i spend on coffee"
        );

        assertThat(bundle.sources()).hasSize(1);
        assertThat(bundle.contextJson()).contains("TRANSACTION_LOOKUP");
        assertThat(bundle.contextJson()).contains("references");
        verify(ragService).summaries(any());
        verify(ragService).search(any(), any());
    }
}
