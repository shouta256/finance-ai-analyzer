package com.safepocket.ledger.security;

import java.util.Optional;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

@Component
public class AuthenticatedUserProvider {

    public UUID requireCurrentUserId() {
        return currentUserId().orElseThrow(() -> new IllegalStateException("user context missing"));
    }

    public Optional<UUID> currentUserId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof JwtAuthenticationToken jwtAuthentication) {
            String subject = jwtAuthentication.getName();
            try {
                UUID userId = UUID.fromString(subject);
                RequestContextHolder.setUserId(userId);
                return Optional.of(userId);
            } catch (IllegalArgumentException ignored) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }
}
