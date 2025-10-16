package com.safepocket.ledger.controller.dto;

import java.time.LocalDate;
import java.util.List;

public record TransactionsListResponseDto(PeriodDto period, List<TransactionResponseDto> transactions, String traceId) {

    public record PeriodDto(String month, LocalDate from, LocalDate to) {
    }
}
