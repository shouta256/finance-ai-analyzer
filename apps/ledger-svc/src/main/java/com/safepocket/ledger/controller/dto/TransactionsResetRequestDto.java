package com.safepocket.ledger.controller.dto;

public record TransactionsResetRequestDto(Boolean unlinkPlaid) {
    public boolean unlinkPlaidFlag() {
        return Boolean.TRUE.equals(unlinkPlaid);
    }
}
