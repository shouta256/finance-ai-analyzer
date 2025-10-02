package com.safepocket.ledger.controller.dto;

import java.time.Instant;

public record PlaidLinkTokenResponseDto(String linkToken, Instant expiration, String requestId) {
}
