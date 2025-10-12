package com.safepocket.ledger.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "plaid_items")
public class PlaidItemEntity {
    @Id
    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "item_id", nullable = false, unique = true)
    private String itemId;

    @Column(name = "encrypted_access_token", nullable = false, length = 2048)
    private String encryptedAccessToken;

    @Column(name = "linked_at", nullable = false)
    private Instant linkedAt;

    public PlaidItemEntity() {}

    public PlaidItemEntity(UUID userId, String itemId, String encryptedAccessToken, Instant linkedAt) {
        this.userId = userId;
        this.itemId = itemId;
        this.encryptedAccessToken = encryptedAccessToken;
        this.linkedAt = linkedAt;
    }

    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public String getItemId() { return itemId; }
    public void setItemId(String itemId) { this.itemId = itemId; }
    public String getEncryptedAccessToken() { return encryptedAccessToken; }
    public void setEncryptedAccessToken(String encryptedAccessToken) { this.encryptedAccessToken = encryptedAccessToken; }
    public Instant getLinkedAt() { return linkedAt; }
    public void setLinkedAt(Instant linkedAt) { this.linkedAt = linkedAt; }
}
