package com.safepocket.ledger.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.ai.OpenAiResponsesClient;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.security.RequestContextHolder;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ChatService {
    private static final Logger log = LoggerFactory.getLogger(ChatService.class);

    private final ChatMessageRepository repository;
    private final OpenAiResponsesClient openAiClient;
    private final ChatContextService chatContextService;
    private final ChatMessageRetentionManager retentionManager;
    private final ObjectMapper objectMapper;

    private volatile boolean apiKeyWarned = false;
    private static final DateTimeFormatter LONG_DATE_FORMAT = DateTimeFormatter.ofPattern("MMMM d, uuuu", Locale.US);
    private static final DateTimeFormatter SHORT_DATE_FORMAT = DateTimeFormatter.ofPattern("MMM d, uuuu", Locale.US);

    private static final String SYSTEM_PROMPT = "You are Safepocket's financial helper. Use the provided context to answer. "
        + "Context JSON includes 'intent', 'assistantScope', and optionally 'summary' and 'retrieved'. "
        + "If intent is GREETING, answer briefly and invite the user to ask about spending, income, categories, or merchants. "
        + "If intent is OUT_OF_SCOPE, explain that you can only help with the user's own financial data and do not mention account totals or transactions. "
        + "If intent is SUMMARY_ONLY, answer from the summary only and do not rely on transaction references. "
        + "If intent is TRANSACTION_LOOKUP, answer from the retrieved transaction references first. "
        + "Context JSON has two parts: 'summary' (month totals, top categories/merchants) and 'retrieved' (rowsCsv + dict + references). "
        + "Every field ending in 'Cents' is an integer number of cents and must be divided by 100 to produce US dollars. "
        + "If 'retrieved.rowsCsv' is present, treat it as compact CSV with headers: tx,occurredOn,merchant,amountCents,category. "
        + "Use 'retrieved.dict.merchants' and 'retrieved.dict.categories' to map short codes to masked labels. "
        + "Use 'retrieved.references' first when the user asks about a specific merchant, keyword, category, or 'how much did I spend' style question. "
        + "Do not fall back to a generic monthly summary if retrieved transactions clearly match the question. "
        + "For spend-total questions, sum the matching negative amountCents values, report the absolute dollar amount, and mention the matching merchants/dates. "
        + "If no matching retrieved transactions exist, say that clearly instead of inventing an answer. "
        + "Report amounts in US dollars with sign-aware formatting, cite dates explicitly, and never invent facts beyond the context.";

    // Heuristics to avoid provider truncation: cap context and history message sizes
    private static final int MAX_CONTEXT_CHARS = 8000;  // ~8KB
    private static final int MAX_HISTORY_MSG_CHARS = 1200;
    private static final int MAX_HISTORY_MESSAGES = 3;   // keep it short to reduce token usage

    public ChatService(ChatMessageRepository repository,
                       OpenAiResponsesClient openAiClient,
                       ChatContextService chatContextService,
                       ChatMessageRetentionManager retentionManager,
                       ObjectMapper objectMapper) {
        this.repository = repository;
        this.openAiClient = openAiClient;
        this.chatContextService = chatContextService;
        this.retentionManager = retentionManager;
        this.objectMapper = objectMapper;
    }

    public record ChatResponse(UUID conversationId, List<ChatMessageDto> messages, String traceId) {}
    public record ChatDeleteResponse(String status, String traceId) {}
    public record ChatMessageDto(UUID id, String role, String content, Instant createdAt, List<ChatSourceDto> sources) {}
    public record ChatSourceDto(
            String txCode,
            UUID transactionId,
            LocalDate occurredOn,
            String merchant,
            int amountCents,
            String category,
            double score,
            List<String> matchedTerms,
            List<String> reasons
    ) {}

    private record GeneratedAssistantReply(String content, List<ChatSourceDto> sources) {}

    private record ChatMessageMetadata(List<ChatSourceDto> sources) {}

    @Transactional
    public ChatResponse sendMessage(UUID userId, UUID conversationId, String message, java.util.UUID truncateFromMessageId) {
        chatContextService.assertRagReady(userId);
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
                        target.setMetadataJson(null);
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

        GeneratedAssistantReply assistantReply;
        try {
            assistantReply = generateAssistantReply(convId, userId, message);
        } catch (Exception ex) {
            String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId)
                    .orElseGet(() -> UUID.randomUUID().toString());
            log.error("AI chat: failed to generate reply for conversation {} user {} traceId {}", convId, userId, traceId, ex);
            assistantReply = new GeneratedAssistantReply(
                    "(Fallback) I cannot create a reply now. Please contact support and share traceId=" + traceId + ".",
                    List.of()
            );
        }
        ChatMessageEntity assistantMsg = new ChatMessageEntity(
                UUID.randomUUID(),
                convId,
                userId,
                ChatMessageEntity.Role.ASSISTANT,
                assistantReply.content(),
                Instant.now()
        );
        assistantMsg.setMetadataJson(serializeMetadata(assistantReply.sources()));
        repository.save(assistantMsg);

        Instant cutoff = retentionManager.currentCutoff();
        List<ChatMessageDto> msgs = repository.findByConversationIdAndUserIdOrderByCreatedAtAsc(convId, userId).stream()
                .filter(e -> !e.getCreatedAt().isBefore(cutoff))
                .map(this::toDto)
                .collect(Collectors.toList());
        return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
    }

    private GeneratedAssistantReply generateAssistantReply(UUID conversationId, UUID userId, String latestUserMessage) {
        try {
            if (!openAiClient.hasCredentials()) {
                if (!apiKeyWarned) {
                    log.warn("AI chat: no provider credentials configured, using fallback (this warning is printed once)");
                    apiKeyWarned = true;
                }
                return new GeneratedAssistantReply(
                        "(Fallback) I understand. The assistant runs in sandbox mode now. Your message: " + latestUserMessage,
                        List.of()
                );
            }

            ChatContextService.ChatContextBundle contextBundle =
                    chatContextService.buildContextBundle(userId, conversationId, latestUserMessage);
            String context = contextBundle.contextJson();
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
                List<ChatSourceDto> citedSources = filterSourcesForReply(
                        aiReply.get(),
                        mapSources(contextBundle.sources()),
                        extractIntent(contextBundle.contextJson())
                );
                return new GeneratedAssistantReply(aiReply.get(), citedSources);
            }
            log.warn("AI chat: model did not return content, using fallback");
            return new GeneratedAssistantReply("(Fallback) I could not create a reply, but your message is saved.", List.of());
        } catch (Exception ex) {
            String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId)
                    .orElseGet(() -> UUID.randomUUID().toString());
            log.error("AI chat: unexpected failure building reply traceId {}", traceId, ex);
            // Use phrasing consistent with outer fallback for test stability and UX
            return new GeneratedAssistantReply(
                    "(Fallback) I could not create a reply. Please share traceId=" + traceId + " with support.",
                    List.of()
            );
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
                .map(this::toDto)
                .collect(Collectors.toList());
        UUID convId = history.get(0).getConversationId();
        return new ChatResponse(convId, msgs, UUID.randomUUID().toString());
    }

    @Transactional
    public ChatDeleteResponse deleteConversation(UUID userId, UUID conversationId) {
        retentionManager.purgeExpiredMessagesNow();
        if (conversationId != null) {
            repository.deleteByConversationIdAndUserId(conversationId, userId);
        } else {
            repository.deleteByUserId(userId);
        }
        return new ChatDeleteResponse("DELETED", UUID.randomUUID().toString());
    }

    private ChatMessageDto toDto(ChatMessageEntity entity) {
        return new ChatMessageDto(
                entity.getId(),
                entity.getRole().name(),
                entity.getContent(),
                entity.getCreatedAt(),
                parseSources(entity.getMetadataJson())
        );
    }

    private List<ChatSourceDto> mapSources(List<RagService.SearchReference> references) {
        if (references == null || references.isEmpty()) {
            return List.of();
        }
        return references.stream()
                .map(ref -> new ChatSourceDto(
                        ref.txCode(),
                        ref.transactionId(),
                        ref.occurredOn(),
                        ref.merchant(),
                        ref.amountCents(),
                        ref.category(),
                        ref.score(),
                        ref.matchedTerms(),
                        ref.reasons()
                ))
                .toList();
    }

    private List<ChatSourceDto> filterSourcesForReply(String reply, List<ChatSourceDto> sources, String intent) {
        if (reply == null || reply.isBlank() || sources == null || sources.isEmpty()) {
            return List.of();
        }
        if (intent != null && !"TRANSACTION_LOOKUP".equals(intent)) {
            return List.of();
        }
        String normalizedReply = normalizeText(reply);
        String lowerReply = reply.toLowerCase(Locale.US);
        List<ChatSourceDto> filtered = sources.stream()
                .filter(source -> sourceMentionedInReply(source, normalizedReply, lowerReply))
                .toList();
        return filtered.isEmpty() ? sources.stream().limit(3).toList() : filtered;
    }

    private boolean sourceMentionedInReply(ChatSourceDto source, String normalizedReply, String lowerReply) {
        if (source == null) {
            return false;
        }
        String normalizedMerchant = normalizeText(source.merchant());
        if (!normalizedMerchant.isBlank() && normalizedReply.contains(normalizedMerchant)) {
            return true;
        }
        for (String token : normalizedMerchant.split(" ")) {
            if (token.length() >= 5 && normalizedReply.contains(token)) {
                return true;
            }
        }
        if (source.matchedTerms() != null) {
            for (String term : source.matchedTerms()) {
                String normalizedTerm = normalizeText(term);
                if (normalizedTerm.length() >= 4 && normalizedReply.contains(normalizedTerm)) {
                    return true;
                }
            }
        }
        if (source.occurredOn() != null) {
            String longDate = source.occurredOn().format(LONG_DATE_FORMAT).toLowerCase(Locale.US);
            String shortDate = source.occurredOn().format(SHORT_DATE_FORMAT).toLowerCase(Locale.US);
            return lowerReply.contains(longDate) || lowerReply.contains(shortDate);
        }
        return false;
    }

    private String normalizeText(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        return text.toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ")
                .trim()
                .replaceAll("\\s+", " ");
    }

    private String extractIntent(String contextJson) {
        if (contextJson == null || contextJson.isBlank()) {
            return null;
        }
        try {
            JsonNode root = objectMapper.readTree(contextJson);
            JsonNode intent = root.get("intent");
            return intent != null && intent.isTextual() ? intent.asText() : null;
        } catch (JsonProcessingException e) {
            log.warn("AI chat: failed to parse context intent", e);
            return null;
        }
    }

    private String serializeMetadata(List<ChatSourceDto> sources) {
        if (sources == null || sources.isEmpty()) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(new ChatMessageMetadata(sources));
        } catch (JsonProcessingException e) {
            log.warn("AI chat: failed to serialize message metadata", e);
            return null;
        }
    }

    private List<ChatSourceDto> parseSources(String metadataJson) {
        if (metadataJson == null || metadataJson.isBlank()) {
            return List.of();
        }
        try {
            ChatMessageMetadata metadata = objectMapper.readValue(metadataJson, ChatMessageMetadata.class);
            return metadata.sources() != null ? metadata.sources() : List.of();
        } catch (Exception e) {
            log.warn("AI chat: failed to parse message metadata", e);
            return List.of();
        }
    }
}
