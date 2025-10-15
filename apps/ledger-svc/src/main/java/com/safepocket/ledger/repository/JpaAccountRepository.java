package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.AccountEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface JpaAccountRepository extends JpaRepository<AccountEntity, UUID> {
    List<AccountEntity> findByUserId(UUID userId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("DELETE FROM AccountEntity a WHERE a.userId = :userId")
    int deleteByUserId(@Param("userId") UUID userId);

    @Query("""
            SELECT new com.safepocket.ledger.repository.AccountBalanceProjection(
                a.id,
                a.userId,
                a.name,
                a.institution,
                a.createdAt,
                COALESCE(SUM(t.amount), 0),
                MAX(t.occurredAt)
            )
            FROM AccountEntity a
            LEFT JOIN TransactionEntity t ON t.accountId = a.id AND t.userId = a.userId
            WHERE a.userId = :userId
            GROUP BY a.id, a.userId, a.name, a.institution, a.createdAt
            ORDER BY a.createdAt ASC
            """)
    List<AccountBalanceProjection> findSummariesByUserId(@Param("userId") UUID userId);
}
