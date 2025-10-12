package com.safepocket.ledger.ai;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "ai_monthly_highlights")
public class AiMonthlyHighlightEntity {

    @Id
    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Column(name = "month", nullable = false, length = 7)
    private String month;

    @Column(name = "title", nullable = false)
    private String title;

    @Column(name = "summary", nullable = false, columnDefinition = "text")
    private String summary;

    @Column(name = "sentiment", nullable = false, length = 16)
    private String sentiment;

    @Column(name = "recommendations", nullable = false, columnDefinition = "text")
    private String recommendations;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected AiMonthlyHighlightEntity() {
    }

    public AiMonthlyHighlightEntity(UUID userId, String month, String title, String summary, String sentiment, String recommendations) {
        this.userId = userId;
        this.month = month;
        this.title = title;
        this.summary = summary;
        this.sentiment = sentiment;
        this.recommendations = recommendations;
    }

    @PrePersist
    void prePersist() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getUserId() {
        return userId;
    }

    public String getMonth() {
        return month;
    }

    public void setMonth(String month) {
        this.month = month;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getSummary() {
        return summary;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public String getSentiment() {
        return sentiment;
    }

    public void setSentiment(String sentiment) {
        this.sentiment = sentiment;
    }

    public String getRecommendations() {
        return recommendations;
    }

    public void setRecommendations(String recommendations) {
        this.recommendations = recommendations;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
