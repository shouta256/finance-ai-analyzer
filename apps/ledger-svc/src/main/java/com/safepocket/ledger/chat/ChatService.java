package com.safepocket.ledger.chat;

import com.safepocket.ledger.ai.OpenAiResponsesClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class ChatService {
    private static final Logger log = LoggerFactory.getLogger(ChatService.class);

    private final ChatMessageRepository repository;
    private final OpenAiResponsesClient openAiClient;
    private final ChatContextService chatContextService;

    private volatile boolean apiKeyWarned = false;

    private static final String SYSTEM_PROMPT = "You are Safepocket's financial assistant. Use the provided account "
            + "summaries as context, cite concrete amounts and dates when available, and never fabricate data.";

    public ChatService(ChatMessageRepository repository, OpenAiResponsesClient openAiClient, ChatContextService chatContextService) {
        this.repository = repository;
        this.openAiClient = openAiClient;
        this.chatContextService = chatContextService;
    }

public record ChatResponse(UUID conversationId, List<ChatMessageDto> messages, String traceId) {}
public record ChatMessageDto(UUID id, String role, String content, Instant createdAt) {}

@Transactional
public ChatResponse sendMessage(UUID userId, UUID conversationId, String message) {
        boolean newConversation = conversationId == null;
        UUID convId = newConversation ? UUID.randomUUID() : conversationId;
        Instant now = Instant.now();

        ChatMessageEntity userMsg = new ChatMessageEntity(UUID.randomUUID(), convId, userId, ChatMessageEntity.Role.USER, message, now);
        repository.save(userMsg);

        String assistantContent = generateAssistantReply(convId, userId, message);
        ChatMessageEntity assistantMsg = new ChatMessageEntity(UUID.randomUUID(), convId, userId, ChatMessageEntity.Role.ASSISTANT, assistantContent, Instant.now());
        repository.save(assistantMsg);

        List<ChatMessageDto> msgs = repository.findByConversationIdOrderByCreatedAtAsc(convId).stream()
                .map(e -> new ChatMessageDto(e.getId(), e.getRole().name(), e.getContent(), e.getCreatedAt()))
                .collect(Collectors.toList());
        return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
    }

    private String generateAssistantReply(UUID conversationId, UUID userId, String latestUserMessage) {
        if (!openAiClient.hasCredentials()) {
            if (!apiKeyWarned) {
                log.warn("AI chat: OPENAI_API_KEY が設定されていないため fallback 応答を使用します (以後同警告抑制)" );
                apiKeyWarned = true;
            }
            return "(Fallback) 了解しました。現在はサンドボックスモードです — メッセージ: " + latestUserMessage;
        }

        String context = chatContextService.buildContext(userId, latestUserMessage);
        List<OpenAiResponsesClient.Message> messages = new ArrayList<>();
        messages.add(new OpenAiResponsesClient.Message("system", SYSTEM_PROMPT));
        if (!context.isBlank()) {
            messages.add(new OpenAiResponsesClient.Message("system", "Account summary context (JSON):\n" + context));
        }
        messages.add(new OpenAiResponsesClient.Message("user", latestUserMessage));

        Optional<String> aiReply = openAiClient.generateText(messages, 400);

        if (aiReply.isPresent()) {
            return aiReply.get();
        }
        log.warn("AI chat: OpenAI 応答が取得できなかったため fallback 表示");
        return "(Fallback) 応答を生成できませんでしたがメッセージは保存されました。";
    }
}

@Transactional(readOnly = true)
public ChatResponse getConversation(UUID userId, UUID conversationId) {
    List<ChatMessageEntity> history;
    UUID resolvedConversationId = conversationId;
    if (conversationId != null) {
        history = repository.findByConversationIdOrderByCreatedAtAsc(conversationId);
    } else {
        history = repository.findLatestConversation(userId, org.springframework.data.domain.PageRequest.of(0, 1));
        if (!history.isEmpty()) {
            resolvedConversationId = history.get(0).getConversationId();
        }
    }
    if (history.isEmpty()) {
        UUID newConvId = resolvedConversationId != null ? resolvedConversationId : UUID.randomUUID();
        return new ChatResponse(newConvId, List.of(), UUID.randomUUID().toString());
    }
    List<ChatMessageDto> msgs = history.stream()
            .map(e -> new ChatMessageDto(e.getId(), e.getRole().name(), e.getContent(), e.getCreatedAt()))
            .collect(Collectors.toList());
    UUID convId = history.get(0).getConversationId();
    return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
}
