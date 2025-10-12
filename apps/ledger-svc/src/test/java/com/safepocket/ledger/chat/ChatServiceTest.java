package com.safepocket.ledger.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.ai.OpenAiResponsesClient;
import com.safepocket.ledger.security.RequestContextHolder;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
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
        chatService = new ChatService(repository, openAiClient, chatContextService, retentionManager);
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
        when(chatContextService.buildContext(any(UUID.class), any(UUID.class), anyString()))
                .thenThrow(new RuntimeException("boom"));
        when(openAiClient.hasCredentials()).thenReturn(true);

        ChatService.ChatResponse response = chatService.sendMessage(userId, null, "hello", null);

        assertThat(response.messages()).hasSize(2);
        String assistantContent = response.messages().getLast().content();
        assertThat(assistantContent).contains("traceId=test-trace");
        assertThat(assistantContent).contains("Please share traceId");
    }
}
