package com.safepocket.ledger.plaid;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class InMemoryPlaidItemRepository implements PlaidItemRepository {

    private final Map<UUID, PlaidItem> storage = new ConcurrentHashMap<>();

    @Override
    public PlaidItem save(PlaidItem item) {
        storage.put(item.userId(), item);
        return item;
    }

    @Override
    public Optional<PlaidItem> findByUserId(UUID userId) {
        return Optional.ofNullable(storage.get(userId));
    }
}
