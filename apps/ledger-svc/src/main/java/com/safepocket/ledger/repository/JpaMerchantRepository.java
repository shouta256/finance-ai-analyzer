package com.safepocket.ledger.repository;

import com.safepocket.ledger.entity.MerchantEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface JpaMerchantRepository extends JpaRepository<MerchantEntity, UUID> {

    Optional<MerchantEntity> findByNameIgnoreCase(String name);
}
