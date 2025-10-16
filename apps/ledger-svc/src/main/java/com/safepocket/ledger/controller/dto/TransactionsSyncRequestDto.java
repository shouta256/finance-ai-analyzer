package com.safepocket.ledger.controller.dto;

public record TransactionsSyncRequestDto(String cursor, Boolean forceFullSync, Boolean demoSeed, String startDate) {
    public boolean forceFullSyncFlag() {
        return Boolean.TRUE.equals(forceFullSync);
    }

    public boolean demoSeedFlag() {
        return Boolean.TRUE.equals(demoSeed);
    }

    public java.util.Optional<java.time.LocalDate> startDateValue() {
        if (startDate == null || startDate.isBlank()) {
            return java.util.Optional.empty();
        }
        try {
            return java.util.Optional.of(java.time.LocalDate.parse(startDate));
        } catch (java.time.format.DateTimeParseException ex) {
            throw new IllegalArgumentException("Invalid startDate format");
        }
    }
}
