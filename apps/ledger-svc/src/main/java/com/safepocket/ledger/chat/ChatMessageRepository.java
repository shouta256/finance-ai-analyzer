package com.safepocket.ledger.chat;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface ChatMessageRepository extends JpaRepository<ChatMessageEntity, UUID> {
    List<ChatMessageEntity> findByConversationIdOrderByCreatedAtAsc(UUID conversationId);

    @Query("SELECT m FROM ChatMessageEntity m WHERE m.userId = :userId AND m.conversationId = ("
            + "SELECT cm.conversationId FROM ChatMessageEntity cm WHERE cm.userId = :userId"
            + " ORDER BY cm.createdAt DESC LIMIT 1"
            + ") ORDER BY m.createdAt ASC")
    List<ChatMessageEntity> findLatestConversation(UUID userId, org.springframework.data.domain.Pageable pageable);
}
