package com.safepocket.ledger.ai;

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface AiHighlightRepository extends JpaRepository<AiMonthlyHighlightEntity, UUID> {
}
