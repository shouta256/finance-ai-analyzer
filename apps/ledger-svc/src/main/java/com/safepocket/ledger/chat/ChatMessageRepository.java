package com.safepocket.ledger.chat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface ChatMessageRepository extends JpaRepository<ChatMessageEntity, UUID> {
    List<ChatMessageEntity> findByConversationIdOrderByCreatedAtAsc(UUID conversationId);

    ChatMessageEntity findFirstByUserIdOrderByCreatedAtDesc(UUID userId);

    List<ChatMessageEntity> findByConversationIdAndUserIdOrderByCreatedAtAsc(UUID conversationId, UUID userId);

    boolean existsByConversationIdAndUserId(UUID conversationId, UUID userId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from ChatMessageEntity m where m.createdAt < :threshold")
    int deleteOlderThan(@Param("threshold") Instant threshold);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from ChatMessageEntity m where m.conversationId = :conversationId and m.createdAt > :cutoff")
    int deleteConversationTail(@Param("conversationId") UUID conversationId, @Param("cutoff") Instant cutoff);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from ChatMessageEntity m where m.userId = :userId")
    int deleteByUserId(@Param("userId") UUID userId);
}
