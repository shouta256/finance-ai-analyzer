package com.safepocket.ledger.controller;

import com.safepocket.ledger.chat.ChatService;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping({"/ai/chat", "/api/chat"})
@Validated
public class ChatController {

    private final ChatService chatService;

    public ChatController(ChatService chatService) {
        this.chatService = chatService;
    }

    public record ChatRequest(UUID conversationId, @NotBlank String message, UUID truncateFromMessageId) {}
    public record ChatMessageDto(UUID id, String role, String content, java.time.Instant createdAt) {}
    public record ChatResponseDto(UUID conversationId, java.util.List<ChatMessageDto> messages, String traceId) {}

    @GetMapping
    public ResponseEntity<ChatResponseDto> history(@RequestParam(value = "conversationId", required = false) UUID conversationId,
                                                   Authentication auth) {
        UUID userId = UUID.fromString("0f08d2b9-28b3-4b28-bd33-41a36161e9ab");
        if (auth != null && auth.getName() != null) {
            try { userId = UUID.fromString(auth.getName()); } catch (Exception ignored) {}
        }
        var res = chatService.getConversation(userId, conversationId);
        var dto = new ChatResponseDto(res.conversationId(),
                res.messages().stream().map(m -> new ChatMessageDto(m.id(), m.role(), m.content(), m.createdAt())).toList(),
                res.traceId());
        return ResponseEntity.ok(dto);
    }

    @PostMapping
    public ResponseEntity<ChatResponseDto> chat(@RequestBody ChatRequest request, Authentication auth) {
        UUID userId = UUID.fromString("0f08d2b9-28b3-4b28-bd33-41a36161e9ab"); // demo user default
        if (auth != null && auth.getName() != null) {
            try { userId = UUID.fromString(auth.getName()); } catch (Exception ignored) {}
        }
        var res = chatService.sendMessage(userId, request.conversationId(), request.message(), request.truncateFromMessageId());
        var dto = new ChatResponseDto(res.conversationId(), res.messages().stream().map(m -> new ChatMessageDto(m.id(), m.role(), m.content(), m.createdAt())).toList(), res.traceId());
        return ResponseEntity.ok(dto);
    }
}
