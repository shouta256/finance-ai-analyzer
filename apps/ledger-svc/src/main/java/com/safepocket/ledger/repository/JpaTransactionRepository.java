package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.TransactionEntity;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface JpaTransactionRepository extends JpaRepository<TransactionEntity, UUID> {
    
    @Query("SELECT t FROM TransactionEntity t WHERE t.userId = :userId AND t.occurredAt >= :startOfMonth AND t.occurredAt < :startOfNextMonth ORDER BY t.occurredAt DESC")
    List<TransactionEntity> findByUserIdAndMonth(@Param("userId") UUID userId, 
                                                 @Param("startOfMonth") Instant startOfMonth, 
                                                 @Param("startOfNextMonth") Instant startOfNextMonth);

    @Query("SELECT t FROM TransactionEntity t WHERE t.userId = :userId AND t.accountId = :accountId AND t.occurredAt >= :startOfMonth AND t.occurredAt < :startOfNextMonth ORDER BY t.occurredAt DESC")
    List<TransactionEntity> findByUserIdAndMonthAndAccount(@Param("userId") UUID userId,
                                                           @Param("startOfMonth") Instant startOfMonth,
                                                           @Param("startOfNextMonth") Instant startOfNextMonth,
                                                           @Param("accountId") UUID accountId);

    @Query("SELECT t FROM TransactionEntity t WHERE t.userId = :userId AND t.occurredAt >= :from AND t.occurredAt < :to ORDER BY t.occurredAt DESC")
    List<TransactionEntity> findByUserIdAndRange(@Param("userId") UUID userId,
                                                 @Param("from") Instant from,
                                                 @Param("to") Instant to);

    @Query("SELECT t FROM TransactionEntity t WHERE t.userId = :userId AND t.accountId = :accountId AND t.occurredAt >= :from AND t.occurredAt < :to ORDER BY t.occurredAt DESC")
    List<TransactionEntity> findByUserIdAndRangeAndAccount(@Param("userId") UUID userId,
                                                           @Param("from") Instant from,
                                                           @Param("to") Instant to,
                                                           @Param("accountId") UUID accountId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("DELETE FROM TransactionEntity t WHERE t.userId = :userId")
    int deleteByUserId(@Param("userId") UUID userId);
}
