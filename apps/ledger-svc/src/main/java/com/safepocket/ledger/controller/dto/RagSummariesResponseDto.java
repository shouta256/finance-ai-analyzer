package com.safepocket.ledger.controller.dto;

import java.util.List;

public record RagSummariesResponseDto(
        String month,
        TotalsDto totals,
        List<CategoryDto> categories,
        List<MerchantDto> merchants,
        String traceId
) {
    public record TotalsDto(long income, long expense, long net) {
    }

    public record CategoryDto(String code, String label, int count, long sum, long avg) {
    }

    public record MerchantDto(String merchantId, String label, int count, long sum) {
    }
}
