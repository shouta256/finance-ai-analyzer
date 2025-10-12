package com.safepocket.ledger.controller.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.time.LocalDate;
import java.util.List;

public record RagSearchRequestDto(
        String q,
        @JsonFormat(pattern = "yyyy-MM-dd") LocalDate from,
        @JsonFormat(pattern = "yyyy-MM-dd") LocalDate to,
        List<String> categories,
        @Min(0) Integer amountMin,
        @Min(0) Integer amountMax,
        @Min(1) @Max(100) Integer topK,
        List<String> fields
) {
}
