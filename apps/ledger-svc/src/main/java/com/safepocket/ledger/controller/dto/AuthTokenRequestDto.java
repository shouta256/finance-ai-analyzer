package com.safepocket.ledger.controller.dto;

public record AuthTokenRequestDto(
        String grantType,
        String code,
        String redirectUri,
        String codeVerifier,
        String refreshToken
) {
}
