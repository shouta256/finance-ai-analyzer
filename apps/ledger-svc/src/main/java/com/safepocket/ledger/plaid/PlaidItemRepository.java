package com.safepocket.ledger.plaid;

import java.util.Optional;
import java.util.UUID;

public interface PlaidItemRepository {
    PlaidItem save(PlaidItem item);

    Optional<PlaidItem> findByUserId(UUID userId);
}
