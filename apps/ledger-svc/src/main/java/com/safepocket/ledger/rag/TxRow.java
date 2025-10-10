package com.safepocket.ledger.rag;

import java.time.LocalDate;

/**
 * Compact row representation used for CSV compression of transaction slices.
 */
public record TxRow(
        String txCode,
        LocalDate occurredOn,
        String merchantCode,
        int amountCents,
        String categoryCode
) {
}
