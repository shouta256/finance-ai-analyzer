package com.safepocket.ledger.controller.dto;

import jakarta.validation.constraints.NotBlank;

public record PlaidExchangeRequestDto(@NotBlank String publicToken) {
}
