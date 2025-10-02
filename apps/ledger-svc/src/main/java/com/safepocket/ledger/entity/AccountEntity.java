package com.safepocket.ledger.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "accounts")
public class AccountEntity {
    @Id
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "name", nullable = false)
    private String name;

    @Column(name = "institution", nullable = false)
    private String institution;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    // Default constructor for JPA
    public AccountEntity() {}

    // Constructor
    public AccountEntity(UUID id, UUID userId, String name, String institution, Instant createdAt) {
        this.id = id;
        this.userId = userId;
        this.name = name;
        this.institution = institution;
        this.createdAt = createdAt;
    }

    // Getters and setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getInstitution() { return institution; }
    public void setInstitution(String institution) { this.institution = institution; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}