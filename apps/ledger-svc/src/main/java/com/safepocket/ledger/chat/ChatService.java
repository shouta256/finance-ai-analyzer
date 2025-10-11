package com.safepocket.ledger.chat;

import com.safepocket.ledger.ai.OpenAiResponsesClient;
import com.safepocket.ledger.security.RequestContextHolder;
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
    private final ChatMessageRetentionManager retentionManager;

    private volatile boolean apiKeyWarned = false;

    private static final String SYSTEM_PROMPT = "You are Safepocket's financial assistant. Use the provided account "
            + "summaries as context, cite concrete amounts and dates when available, and never fabricate data.";

    public ChatService(ChatMessageRepository repository,
                       OpenAiResponsesClient openAiClient,
                       ChatContextService chatContextService,
                       ChatMessageRetentionManager retentionManager) {
        this.repository = repository;
        this.openAiClient = openAiClient;
        this.chatContextService = chatContextService;
        this.retentionManager = retentionManager;
    }

    public record ChatResponse(UUID conversationId, List<ChatMessageDto> messages, String traceId) {}
    public record ChatMessageDto(UUID id, String role, String content, Instant createdAt) {}

    @Transactional
    public ChatResponse sendMessage(UUID userId, UUID conversationId, String message, java.util.UUID truncateFromMessageId) {
        retentionManager.purgeExpiredMessagesNow();
        UUID convId = conversationId;

        ChatMessageEntity userMsg = null;
        Instant now = Instant.now();

        if (truncateFromMessageId != null) {
            Optional<ChatMessageEntity> targetOpt = repository.findById(truncateFromMessageId);
            if (targetOpt.isPresent()) {
                ChatMessageEntity target = targetOpt.get();
                if (target.getUserId().equals(userId)) {
                    UUID targetConversationId = target.getConversationId();
                    if (convId == null || convId.equals(targetConversationId)) {
                        repository.deleteConversationTail(targetConversationId, target.getCreatedAt());
                        convId = targetConversationId;
                        target.setContent(message);
                        target.setCreatedAt(now);
                        userMsg = repository.save(target);
                    }
                }
            }
        }

        boolean newConversation = convId == null;
        convId = newConversation ? UUID.randomUUID() : convId;

        if (userMsg == null) {
            userMsg = new ChatMessageEntity(UUID.randomUUID(), convId, userId, ChatMessageEntity.Role.USER, message, now);
            repository.save(userMsg);
        }

        String assistantContent;
        try {
            assistantContent = generateAssistantReply(convId, userId, message);
        } catch (Exception ex) {
            String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId)
                    .orElseGet(() -> UUID.randomUUID().toString());
            log.error("AI chat: failed to generate reply for conversation {} user {} traceId {}", convId, userId, traceId, ex);
            assistantContent = "(Fallback) 応答を生成できませんでした。サポートに連絡し、traceId=" + traceId + " を共有してください。";
        }
        ChatMessageEntity assistantMsg = new ChatMessageEntity(UUID.randomUUID(), convId, userId, ChatMessageEntity.Role.ASSISTANT, assistantContent, Instant.now());
        repository.save(assistantMsg);

        Instant cutoff = retentionManager.currentCutoff();
        List<ChatMessageDto> msgs = repository.findByConversationIdOrderByCreatedAtAsc(convId).stream()
                .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                .map(e -> new ChatMessageDto(e.getId(), e.getRole().name(), e.getContent(), e.getCreatedAt()))
                .collect(Collectors.toList());
        return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
    }

    private String generateAssistantReply(UUID conversationId, UUID userId, String latestUserMessage) {
        try {
            if (!openAiClient.hasCredentials()) {
                if (!apiKeyWarned) {
                    log.warn("AI chat: OPENAI_API_KEY が設定されていないため fallback 応答を使用します (以後同警告抑制)" );
                    apiKeyWarned = true;
                }
                return "(Fallback) 了解しました。現在はサンドボックスモードです — メッセージ: " + latestUserMessage;
            }

            String context = chatContextService.buildContext(userId, conversationId, latestUserMessage);
            List<OpenAiResponsesClient.Message> messages = new ArrayList<>();
            messages.add(new OpenAiResponsesClient.Message("system", SYSTEM_PROMPT));
            if (!context.isBlank()) {
                messages.add(new OpenAiResponsesClient.Message("system", "Account summary context (JSON):\n" + context));
            }

            // Include recent conversation history so the assistant can respond with context
            // Keep within retention window and a small sliding window to control tokens
            Instant cutoff = retentionManager.currentCutoff();
            List<ChatMessageEntity> history = repository.findByConversationIdOrderByCreatedAtAsc(conversationId)
                    .stream()
                    .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                    .toList();

            // Keep only the last N messages
            final int maxMessages = 20; // roughly ~10 turns
            int start = Math.max(0, history.size() - maxMessages);
            for (int i = start; i < history.size(); i++) {
                ChatMessageEntity e = history.get(i);
                String role = e.getRole() == ChatMessageEntity.Role.ASSISTANT ? "assistant" : "user";
                messages.add(new OpenAiResponsesClient.Message(role, e.getContent()));
            }

            Optional<String> aiReply = openAiClient.generateText(messages, 400);

            if (aiReply.isPresent()) {
                return aiReply.get();
            }
            log.warn("AI chat: OpenAI 応答が取得できなかったため fallback 表示");
            return "(Fallback) 応答を生成できませんでしたがメッセージは保存されました。";
        } catch (Exception ex) {
            String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId)
                    .orElseGet(() -> UUID.randomUUID().toString());
            log.error("AI chat: unexpected failure building reply traceId {}", traceId, ex);
            // Use phrasing consistent with outer fallback for test stability and UX
            return "(Fallback) 応答を生成できませんでした。traceId=" + traceId + " をサポートへお伝えください。";
        }
    }

    @Transactional(readOnly = true)
    public ChatResponse getConversation(UUID userId, UUID conversationId) {
        Instant cutoff = retentionManager.currentCutoff();
        List<ChatMessageEntity> history;
        UUID resolvedConversationId = conversationId;
        if (conversationId != null) {
            history = repository.findByConversationIdOrderByCreatedAtAsc(conversationId);
        } else {
            ChatMessageEntity latest = repository.findFirstByUserIdOrderByCreatedAtDesc(userId);
            if (latest != null) {
                resolvedConversationId = latest.getConversationId();
                history = repository.findByConversationIdOrderByCreatedAtAsc(resolvedConversationId);
            } else {
                history = List.of();
            }
        }
        history = history.stream()
                .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                .collect(Collectors.toList());
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
}
