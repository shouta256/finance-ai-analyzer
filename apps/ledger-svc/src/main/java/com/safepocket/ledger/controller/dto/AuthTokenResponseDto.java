package com.safepocket.ledger.controller.dto;

import java.util.UUID;

public record AuthTokenResponseDto(
        String accessToken,
        String idToken,
        String refreshToken,
        int expiresIn,
        String tokenType,
        String scope,
        UUID userId,
        String traceId
) {
}
