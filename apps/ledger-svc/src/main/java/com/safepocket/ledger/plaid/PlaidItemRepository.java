package com.safepocket.ledger.plaid;

import com.safepocket.ledger.entity.PlaidItemEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface PlaidItemRepository extends JpaRepository<PlaidItemEntity, UUID> {
    Optional<PlaidItemEntity> findByUserId(UUID userId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from PlaidItemEntity p where p.userId = :userId")
    int deleteByUserId(@Param("userId") UUID userId);
}

