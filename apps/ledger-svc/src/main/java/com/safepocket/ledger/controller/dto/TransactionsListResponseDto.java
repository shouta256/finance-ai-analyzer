package com.safepocket.ledger.controller.dto;

import java.util.List;

public record TransactionsListResponseDto(String month, List<TransactionResponseDto> transactions, String traceId) {
}
