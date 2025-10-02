package com.safepocket.ledger.entity;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "transactions")
public class TransactionEntity {
    @Id
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "account_id", nullable = false)
    private UUID accountId;

    @Column(name = "merchant_id", nullable = false)
    private UUID merchantId;

    @Column(name = "amount", nullable = false, precision = 12, scale = 2)
    private BigDecimal amount;

    @Column(name = "currency", nullable = false, length = 3)
    private String currency;

    @Column(name = "occurred_at", nullable = false)
    private Instant occurredAt;

    @Column(name = "authorized_at")
    private Instant authorizedAt;

    @Column(name = "category", nullable = false)
    private String category;

    @Column(name = "description")
    private String description;

    @Column(name = "pending", nullable = false)
    private boolean pending;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    // Default constructor for JPA
    public TransactionEntity() {}

    // Constructor
    public TransactionEntity(UUID id, UUID userId, UUID accountId, UUID merchantId, 
                           BigDecimal amount, String currency, Instant occurredAt, 
                           Instant authorizedAt, String category, String description, 
                           boolean pending, Instant createdAt) {
        this.id = id;
        this.userId = userId;
        this.accountId = accountId;
        this.merchantId = merchantId;
        this.amount = amount;
        this.currency = currency;
        this.occurredAt = occurredAt;
        this.authorizedAt = authorizedAt;
        this.category = category;
        this.description = description;
        this.pending = pending;
        this.createdAt = createdAt;
    }

    // Getters and setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }

    public UUID getAccountId() { return accountId; }
    public void setAccountId(UUID accountId) { this.accountId = accountId; }

    public UUID getMerchantId() { return merchantId; }
    public void setMerchantId(UUID merchantId) { this.merchantId = merchantId; }

    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }

    public Instant getOccurredAt() { return occurredAt; }
    public void setOccurredAt(Instant occurredAt) { this.occurredAt = occurredAt; }

    public Instant getAuthorizedAt() { return authorizedAt; }
    public void setAuthorizedAt(Instant authorizedAt) { this.authorizedAt = authorizedAt; }

    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public boolean isPending() { return pending; }
    public void setPending(boolean pending) { this.pending = pending; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}