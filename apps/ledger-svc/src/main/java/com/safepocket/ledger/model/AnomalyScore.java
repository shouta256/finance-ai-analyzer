package com.safepocket.ledger.model;

import java.math.BigDecimal;

public record AnomalyScore(
        Method method,
        BigDecimal deltaAmount,
        BigDecimal budgetImpactPercent,
        String commentary
) {
    public enum Method {
        Z_SCORE,
        IQR
    }
}
