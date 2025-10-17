package com.safepocket.ledger.controller.dto;

import com.fasterxml.jackson.annotation.JsonAlias;

public record TransactionsSyncRequestDto(String cursor, Boolean forceFullSync, Boolean demoSeed, @JsonAlias("startDate") String startMonth) {
    public boolean forceFullSyncFlag() {
        return Boolean.TRUE.equals(forceFullSync);
    }

    public boolean demoSeedFlag() {
        return Boolean.TRUE.equals(demoSeed);
    }

    public java.util.Optional<java.time.LocalDate> startDateValue() {
        if (startMonth == null || startMonth.isBlank()) {
            return java.util.Optional.empty();
        }
        String value = startMonth.trim();
        try {
            if (value.matches("\\d{4}-\\d{2}")) {
                return java.util.Optional.of(java.time.YearMonth.parse(value).atDay(1));
            }
            return java.util.Optional.of(java.time.LocalDate.parse(value));
        } catch (java.time.format.DateTimeParseException ex) {
            throw new IllegalArgumentException("Invalid startMonth format");
        }
    }
}
