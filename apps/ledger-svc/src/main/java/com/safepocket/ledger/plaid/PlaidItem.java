package com.safepocket.ledger.plaid;

import java.time.Instant;
import java.util.UUID;

public record PlaidItem(
        UUID userId,
        String itemId,
        String encryptedAccessToken,
        Instant linkedAt
) {
}
