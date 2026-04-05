package com.safepocket.ledger.rag;

import java.util.Map;

public class RagNotReadyException extends RuntimeException {

    private final int status;
    private final String code;
    private final Map<String, Object> details;

    private RagNotReadyException(int status, String code, String message, Map<String, Object> details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }

    public static RagNotReadyException infrastructureMissing() {
        return new RagNotReadyException(
                503,
                "RAG_INFRA_NOT_READY",
                "RAG embeddings table is not initialized",
                Map.of(
                        "table", "tx_embeddings",
                        "action", "Restart the backend so Flyway can create tx_embeddings, then run transaction sync."
                )
        );
    }

    public static RagNotReadyException embeddingsMissing(long transactionCount, long embeddingCount) {
        return new RagNotReadyException(
                409,
                "RAG_INDEX_NOT_READY",
                "RAG embeddings are not ready for this user",
                Map.of(
                        "transactions", transactionCount,
                        "embeddings", embeddingCount,
                        "missingEmbeddings", Math.max(transactionCount - embeddingCount, 0),
                        "action", "Run transaction sync to backfill RAG embeddings before using chat."
                )
        );
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }
}
