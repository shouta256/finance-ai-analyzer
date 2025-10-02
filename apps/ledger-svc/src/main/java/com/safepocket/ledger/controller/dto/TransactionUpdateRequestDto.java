package com.safepocket.ledger.controller.dto;

import jakarta.validation.constraints.Size;

public record TransactionUpdateRequestDto(
        @Size(min = 1, max = 64) String category,
        @Size(max = 255) String notes
) {
}
