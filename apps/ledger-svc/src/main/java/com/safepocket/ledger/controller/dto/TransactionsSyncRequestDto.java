package com.safepocket.ledger.controller.dto;

public record TransactionsSyncRequestDto(String cursor, Boolean forceFullSync) {
    public boolean forceFullSyncFlag() {
        return Boolean.TRUE.equals(forceFullSync);
    }
}
