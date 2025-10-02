package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.AccountEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface JpaAccountRepository extends JpaRepository<AccountEntity, UUID> {
    List<AccountEntity> findByUserId(UUID userId);
}