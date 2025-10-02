package com.safepocket.ledger.model;

import java.math.BigDecimal;

public record AnomalyScore(
        Method method,
        BigDecimal zScore,
        BigDecimal iqrScore,
        String commentary
) {
    public enum Method {
        Z_SCORE,
        IQR
    }
}
