package com.safepocket.ledger.controller.dto;

public record TransactionsSyncRequestDto(String cursor, Boolean forceFullSync, Boolean demoSeed) {
    public boolean forceFullSyncFlag() {
        return Boolean.TRUE.equals(forceFullSync);
    }

    public boolean demoSeedFlag() {
        return Boolean.TRUE.equals(demoSeed);
    }
}
