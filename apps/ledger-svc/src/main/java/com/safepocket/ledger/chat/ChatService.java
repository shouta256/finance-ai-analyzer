package com.safepocket.ledger.chat;

import com.safepocket.ledger.ai.OpenAiResponsesClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class ChatService {
    private static final Logger log = LoggerFactory.getLogger(ChatService.class);

    private final ChatMessageRepository repository;
    private final OpenAiResponsesClient openAiClient;

    private volatile boolean apiKeyWarned = false;

    public ChatService(ChatMessageRepository repository, OpenAiResponsesClient openAiClient) {
        this.repository = repository;
        this.openAiClient = openAiClient;
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

        Optional<String> aiReply = openAiClient.generateText(
                List.of(new OpenAiResponsesClient.Message("user", latestUserMessage)),
                400);

        if (aiReply.isPresent()) {
            return aiReply.get();
        }
        log.warn("AI chat: OpenAI 応答が取得できなかったため fallback 表示");
        return "(Fallback) 応答を生成できませんでしたがメッセージは保存されました。";
    }
}
