package com.safepocket.ledger.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.ai.OpenAiResponsesClient;
import com.safepocket.ledger.rag.RagNotReadyException;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.security.RequestContextHolder;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ChatServiceTest {

    @Mock
    ChatMessageRepository repository;
    @Mock
    OpenAiResponsesClient openAiClient;
    @Mock
    ChatContextService chatContextService;
    @Mock
    ChatMessageRetentionManager retentionManager;

    ChatService chatService;

    @BeforeEach
    void setUp() {
        chatService = new ChatService(
                repository,
                openAiClient,
                chatContextService,
                retentionManager,
                new ObjectMapper().findAndRegisterModules()
        );
        RequestContextHolder.set(RequestContextHolder.RequestContext.builder()
                .userId(UUID.randomUUID())
                .traceId("test-trace")
                .build());
    }

    @AfterEach
    void tearDown() {
        RequestContextHolder.clear();
    }

    @Test
    void sendMessageRejectsWhenRagIsNotReady() {
        UUID userId = UUID.randomUUID();
        doThrow(RagNotReadyException.embeddingsMissing(12, 0)).when(chatContextService).assertRagReady(userId);

        assertThatThrownBy(() -> chatService.sendMessage(userId, null, "hello", null))
                .isInstanceOf(RagNotReadyException.class)
                .hasMessageContaining("RAG embeddings are not ready");

        verifyNoInteractions(repository, openAiClient, retentionManager);
    }

    @Test
    void sendMessageFallsBackWhenContextGenerationFails() {
        UUID userId = UUID.randomUUID();
        List<ChatMessageEntity> saved = new ArrayList<>();
        when(retentionManager.currentCutoff()).thenReturn(Instant.EPOCH);
        when(repository.save(any(ChatMessageEntity.class))).thenAnswer(invocation -> {
            ChatMessageEntity entity = invocation.getArgument(0);
            saved.add(entity);
            return entity;
        });
        when(repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(any(UUID.class), any(UUID.class)))
                .thenAnswer(invocation -> new ArrayList<>(saved));
        when(chatContextService.buildContextBundle(any(UUID.class), any(UUID.class), anyString()))
                .thenThrow(new RuntimeException("boom"));
        when(openAiClient.hasCredentials()).thenReturn(true);

        ChatService.ChatResponse response = chatService.sendMessage(userId, null, "hello", null);

        assertThat(response.messages()).hasSize(2);
        String assistantContent = response.messages().getLast().content();
        assertThat(assistantContent).contains("traceId=test-trace");
        assertThat(assistantContent).contains("Please share traceId");
    }

    @Test
    void sendMessageReturnsRetrievedSourcesForAssistantMessages() {
        UUID userId = UUID.randomUUID();
        List<ChatMessageEntity> saved = new ArrayList<>();
        when(retentionManager.currentCutoff()).thenReturn(Instant.EPOCH);
        when(repository.save(any(ChatMessageEntity.class))).thenAnswer(invocation -> {
            ChatMessageEntity entity = invocation.getArgument(0);
            saved.add(entity);
            return entity;
        });
        when(repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(any(UUID.class), any(UUID.class)))
                .thenAnswer(invocation -> new ArrayList<>(saved));
        when(openAiClient.hasCredentials()).thenReturn(true);
        when(openAiClient.generateText(anyList(), anyInt()))
                .thenReturn(Optional.of("You spent $4.60 at Starbucks on September 15, 2025."));
        when(chatContextService.buildContextBundle(any(UUID.class), any(UUID.class), anyString()))
                .thenReturn(new ChatContextService.ChatContextBundle(
                        "{\"summary\":{},\"retrieved\":{}}",
                        List.of(new RagService.SearchReference(
                                "t33333333",
                                UUID.fromString("33333333-3333-3333-3333-333333333333"),
                                LocalDate.of(2025, 9, 15),
                                "Starbucks",
                                460,
                                "EatingOut",
                                0.812,
                                List.of("coffee"),
                                List.of("matched terms: coffee", "semantic similarity")
                        )),
                        new RagService.Stats(1, 460, 460),
                        "chat-1"
                ));

        ChatService.ChatResponse response = chatService.sendMessage(userId, null, "How much did I spend on coffee?", null);

        assertThat(response.messages()).hasSize(2);
        ChatService.ChatMessageDto assistant = response.messages().getLast();
        assertThat(assistant.sources()).hasSize(1);
        assertThat(assistant.sources().getFirst().merchant()).isEqualTo("Starbucks");
        assertThat(assistant.sources().getFirst().reasons()).contains("semantic similarity");
    }

    @Test
    void sendMessageOmitsSourcesWhenReplyDoesNotReferenceThem() {
        UUID userId = UUID.randomUUID();
        List<ChatMessageEntity> saved = new ArrayList<>();
        when(retentionManager.currentCutoff()).thenReturn(Instant.EPOCH);
        when(repository.save(any(ChatMessageEntity.class))).thenAnswer(invocation -> {
            ChatMessageEntity entity = invocation.getArgument(0);
            saved.add(entity);
            return entity;
        });
        when(repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(any(UUID.class), any(UUID.class)))
                .thenAnswer(invocation -> new ArrayList<>(saved));
        when(openAiClient.hasCredentials()).thenReturn(true);
        when(openAiClient.generateText(anyList(), anyInt()))
                .thenReturn(Optional.of("I can only help with your financial data and transaction history."));
        when(chatContextService.buildContextBundle(any(UUID.class), any(UUID.class), anyString()))
                .thenReturn(new ChatContextService.ChatContextBundle(
                        "{\"intent\":\"OUT_OF_SCOPE\"}",
                        List.of(new RagService.SearchReference(
                                "t33333333",
                                UUID.fromString("33333333-3333-3333-3333-333333333333"),
                                LocalDate.of(2025, 9, 15),
                                "Starbucks",
                                460,
                                "EatingOut",
                                0.812,
                                List.of("coffee"),
                                List.of("matched terms: coffee", "semantic similarity")
                        )),
                        new RagService.Stats(1, 460, 460),
                        "chat-1"
                ));

        ChatService.ChatResponse response = chatService.sendMessage(userId, null, "How much do I weigh?", null);

        assertThat(response.messages()).hasSize(2);
        ChatService.ChatMessageDto assistant = response.messages().getLast();
        assertThat(assistant.sources()).isEmpty();
    }
}
