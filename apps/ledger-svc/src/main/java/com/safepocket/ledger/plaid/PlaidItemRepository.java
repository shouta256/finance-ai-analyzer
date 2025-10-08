package com.safepocket.ledger.plaid;

import com.safepocket.ledger.entity.PlaidItemEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface PlaidItemRepository extends JpaRepository<PlaidItemEntity, UUID> {
    Optional<PlaidItemEntity> findByUserId(UUID userId);
}

