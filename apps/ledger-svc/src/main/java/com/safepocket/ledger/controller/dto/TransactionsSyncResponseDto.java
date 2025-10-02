package com.safepocket.ledger.controller.dto;

public record TransactionsSyncResponseDto(String status, int syncedCount, int pendingCount, String traceId) {
}
