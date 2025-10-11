package com.safepocket.ledger.controller;

import com.safepocket.ledger.chat.ChatService;
import com.safepocket.ledger.user.UserService;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping({"/ai/chat", "/api/chat", "/chat"})
@Validated
public class ChatController {

    private final ChatService chatService;
    private final UserService userService;

    public ChatController(ChatService chatService, UserService userService) {
        this.chatService = chatService;
        this.userService = userService;
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
        // Ensure user row exists for FK constraints
        String email = null;
        String fullName = null;
        if (auth instanceof JwtAuthenticationToken jat) {
            Object e = jat.getTokenAttributes().get("email");
            Object n = jat.getTokenAttributes().get("name");
            email = e != null ? String.valueOf(e) : null;
            fullName = n != null ? String.valueOf(n) : null;
        } else if (auth != null && auth.getPrincipal() instanceof Jwt jwt) {
            email = jwt.getClaimAsString("email");
            fullName = jwt.getClaimAsString("name");
        }
        userService.ensureUserExists(userId, email, fullName);
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
        String email = null;
        String fullName = null;
        if (auth instanceof JwtAuthenticationToken jat) {
            Object e = jat.getTokenAttributes().get("email");
            Object n = jat.getTokenAttributes().get("name");
            email = e != null ? String.valueOf(e) : null;
            fullName = n != null ? String.valueOf(n) : null;
        } else if (auth != null && auth.getPrincipal() instanceof Jwt jwt) {
            email = jwt.getClaimAsString("email");
            fullName = jwt.getClaimAsString("name");
        }
        userService.ensureUserExists(userId, email, fullName);
    var res = chatService.sendMessage(userId, request.conversationId(), request.message(), request.truncateFromMessageId());
        var dto = new ChatResponseDto(res.conversationId(), res.messages().stream().map(m -> new ChatMessageDto(m.id(), m.role(), m.content(), m.createdAt())).toList(), res.traceId());
        return ResponseEntity.ok(dto);
    }
}
