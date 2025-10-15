package com.safepocket.ledger.controller.dto;

import java.math.BigDecimal;
import java.util.List;

public record AccountsListResponseDto(
        String currency,
        BigDecimal totalBalance,
        List<AccountResponseDto> accounts,
        String traceId
) {
}
