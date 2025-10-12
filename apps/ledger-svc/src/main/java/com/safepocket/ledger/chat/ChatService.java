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

    private static final String SYSTEM_PROMPT = "You are Safepocket's financial helper. Use the provided context to answer. "
        + "Context JSON has two parts: 'summary' (month totals, top categories/merchants) and 'retrieved' (rowsCsv + dict). "
        + "If 'retrieved.rowsCsv' is present, treat it as compact CSV with headers: tx,occurredOn,merchant,amountCents,category. "
        + "Use 'retrieved.dict.merchants' and 'retrieved.dict.categories' to map short codes to masked labels. "
        + "Report amounts in US dollars with sign-aware formatting, cite dates explicitly, and never invent facts beyond the context.";

    // Heuristics to avoid provider truncation: cap context and history message sizes
    private static final int MAX_CONTEXT_CHARS = 8000;  // ~8KB
    private static final int MAX_HISTORY_MSG_CHARS = 1200;
    private static final int MAX_HISTORY_MESSAGES = 3;   // keep it short to reduce token usage

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

        if (userMsg == null && convId != null && !repository.existsByConversationIdAndUserId(convId, userId)) {
            convId = null;
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
            assistantContent = "(Fallback) I cannot create a reply now. Please contact support and share traceId=" + traceId + ".";
        }
        ChatMessageEntity assistantMsg = new ChatMessageEntity(UUID.randomUUID(), convId, userId, ChatMessageEntity.Role.ASSISTANT, assistantContent, Instant.now());
        repository.save(assistantMsg);

        Instant cutoff = retentionManager.currentCutoff();
        List<ChatMessageDto> msgs = repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(convId, userId).stream()
                .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                .map(e -> new ChatMessageDto(e.getId(), e.getRole().name(), e.getContent(), e.getCreatedAt()))
                .collect(Collectors.toList());
        return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
    }

    private String generateAssistantReply(UUID conversationId, UUID userId, String latestUserMessage) {
        try {
            if (!openAiClient.hasCredentials()) {
                if (!apiKeyWarned) {
                    log.warn("AI chat: OPENAI_API_KEY missing, using fallback (this warning is printed once)" );
                    apiKeyWarned = true;
                }
                return "(Fallback) I understand. The assistant runs in sandbox mode now. Your message: " + latestUserMessage;
            }

            String context = chatContextService.buildContext(userId, conversationId, latestUserMessage);
            if (context != null && context.length() > MAX_CONTEXT_CHARS) {
                context = context.substring(0, MAX_CONTEXT_CHARS) + "\n[...context truncated...]";
            }
            List<OpenAiResponsesClient.Message> messages = new ArrayList<>();
            messages.add(new OpenAiResponsesClient.Message("system", SYSTEM_PROMPT));
            if (!context.isBlank()) {
                messages.add(new OpenAiResponsesClient.Message("system", "Account summary context (JSON):\n" + context));
            }

            // Include recent conversation history so the assistant can respond with context
            // Keep within retention window and a small sliding window to control tokens
            Instant cutoff = retentionManager.currentCutoff();
            List<ChatMessageEntity> history = repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(conversationId, userId)
                    .stream()
                    .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                    .toList();

            // Keep only the last N messages
            final int maxMessages = MAX_HISTORY_MESSAGES; // roughly ~1-2 turns
            int start = Math.max(0, history.size() - maxMessages);
            for (int i = start; i < history.size(); i++) {
                ChatMessageEntity e = history.get(i);
                String role = e.getRole() == ChatMessageEntity.Role.ASSISTANT ? "assistant" : "user";
                String content = e.getContent();
                if (content != null && content.length() > MAX_HISTORY_MSG_CHARS) {
                    content = content.substring(0, MAX_HISTORY_MSG_CHARS) + "\n[...truncated...]";
                }
                messages.add(new OpenAiResponsesClient.Message(role, content));
            }

            // Use a higher cap to reduce truncation (Gemini may end with MAX_TOKENS otherwise)
            Optional<String> aiReply = openAiClient.generateText(messages, 1200);

            if (aiReply.isPresent()) {
                return aiReply.get();
            }
            log.warn("AI chat: model did not return content, using fallback");
            return "(Fallback) I could not create a reply, but your message is saved.";
        } catch (Exception ex) {
            String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId)
                    .orElseGet(() -> UUID.randomUUID().toString());
            log.error("AI chat: unexpected failure building reply traceId {}", traceId, ex);
            // Use phrasing consistent with outer fallback for test stability and UX
            return "(Fallback) I could not create a reply. Please share traceId=" + traceId + " with support.";
        }
    }

    @Transactional(readOnly = true)
    public ChatResponse getConversation(UUID userId, UUID conversationId) {
        Instant cutoff = retentionManager.currentCutoff();
        List<ChatMessageEntity> history;
        UUID resolvedConversationId = conversationId;
        if (conversationId != null) {
            history = repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(conversationId, userId);
        } else {
            ChatMessageEntity latest = repository.findFirstByUserIdOrderByCreatedAtDesc(userId);
            if (latest != null) {
                resolvedConversationId = latest.getConversationId();
                history = repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(resolvedConversationId, userId);
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
