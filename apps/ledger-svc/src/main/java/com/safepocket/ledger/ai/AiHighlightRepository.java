package com.safepocket.ledger.ai;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface AiHighlightRepository extends JpaRepository<AiMonthlyHighlightEntity, UUID> {
    Optional<AiMonthlyHighlightEntity> findByUserIdAndMonth(UUID userId, String month);

    Optional<AiMonthlyHighlightEntity> findFirstByUserIdOrderByMonthDesc(UUID userId);

    void deleteByUserId(UUID userId);
}
