package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.TransactionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

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
}