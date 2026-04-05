package com.safepocket.ledger.rag;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class TxEmbeddingRepository {
    private static final Logger log = LoggerFactory.getLogger(TxEmbeddingRepository.class);

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final EmbeddingService embeddingService;
    private final AtomicBoolean missingTableWarned = new AtomicBoolean(false);

    public TxEmbeddingRepository(NamedParameterJdbcTemplate jdbcTemplate, EmbeddingService embeddingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.embeddingService = embeddingService;
    }

    public void upsertBatch(List<EmbeddingRecord> records) {
        if (records.isEmpty()) {
            return;
        }
        String sql = """
                INSERT INTO tx_embeddings (tx_id, user_id, yyyymm, category, amount_cents, merchant_id, merchant_normalized, embedding, updated_at)
                VALUES (:txId, :userId, :yyyymm, :category, :amountCents, :merchantId, :merchantNormalized, :embedding::jsonb, now())
                ON CONFLICT (tx_id)
                DO UPDATE SET
                    category = excluded.category,
                    amount_cents = excluded.amount_cents,
                    yyyymm = excluded.yyyymm,
                    merchant_id = excluded.merchant_id,
                    merchant_normalized = excluded.merchant_normalized,
                    embedding = excluded.embedding,
                    updated_at = now();
                """;
        List<MapSqlParameterSource> params = new ArrayList<>(records.size());
        for (EmbeddingRecord record : records) {
            MapSqlParameterSource param = new MapSqlParameterSource()
                    .addValue("txId", record.txId())
                    .addValue("userId", record.userId())
                    .addValue("yyyymm", record.month().toString())
                    .addValue("category", record.category())
                    .addValue("amountCents", record.amountCents())
                    .addValue("merchantId", record.merchantId())
                    .addValue("merchantNormalized", record.merchantNormalized())
                    .addValue("embedding", record.embedding() != null ? embeddingService.formatForSql(record.embedding()) : "[]");
            params.add(param);
        }
        try {
            jdbcTemplate.batchUpdate(sql, params.toArray(MapSqlParameterSource[]::new));
        } catch (DataAccessException ex) {
            if (isMissingEmbeddingsTable(ex)) {
                warnMissingTableOnce(ex);
                return;
            }
            throw ex;
        }
    }

    public void deleteByUserId(UUID userId) {
        MapSqlParameterSource params = new MapSqlParameterSource().addValue("userId", userId);
        try {
            jdbcTemplate.update("DELETE FROM tx_embeddings WHERE user_id = :userId", params);
        } catch (DataAccessException ex) {
            if (isMissingEmbeddingsTable(ex)) {
                warnMissingTableOnce(ex);
                return;
            }
            throw ex;
        }
    }

    public boolean embeddingsTableExists() {
        try {
            Boolean exists = jdbcTemplate.queryForObject(
                    "SELECT to_regclass('public.tx_embeddings') IS NOT NULL",
                    new MapSqlParameterSource(),
                    Boolean.class
            );
            return Boolean.TRUE.equals(exists);
        } catch (DataAccessException ex) {
            return false;
        }
    }

    public long countByUserId(UUID userId) {
        if (!embeddingsTableExists()) {
            return 0L;
        }
        try {
            Long count = jdbcTemplate.queryForObject(
                    "SELECT count(*) FROM tx_embeddings WHERE user_id = :userId",
                    new MapSqlParameterSource().addValue("userId", userId),
                    Long.class
            );
            return count != null ? count : 0L;
        } catch (DataAccessException ex) {
            if (isMissingEmbeddingsTable(ex)) {
                warnMissingTableOnce(ex);
                return 0L;
            }
            throw ex;
        }
    }

    public List<EmbeddingMatch> findNearest(
            UUID userId,
            float[] queryVector,
            LocalDate from,
            LocalDate to,
            List<String> categories,
            Integer amountMin,
            Integer amountMax,
            int limit
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT e.tx_id,
                       e.merchant_id,
                       e.embedding,
                       t.occurred_at,
                       t.amount,
                       t.category
                FROM tx_embeddings e
                JOIN transactions t ON t.id = e.tx_id
                WHERE e.user_id = :userId
                """);
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("limit", limit);
        if (from != null) {
            sql.append(" AND t.occurred_at >= :from");
            params.addValue("from", java.sql.Timestamp.from(from.atStartOfDay(java.time.ZoneOffset.UTC).toInstant()));
        }
        if (to != null) {
            sql.append(" AND t.occurred_at < :to");
            params.addValue("to", java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(java.time.ZoneOffset.UTC).toInstant()));
        }
        if (categories != null && !categories.isEmpty()) {
            sql.append(" AND t.category IN (:categories)");
            params.addValue("categories", categories);
        }
        if (amountMin != null) {
            sql.append(" AND e.amount_cents >= :amountMin");
            params.addValue("amountMin", amountMin);
        }
        if (amountMax != null) {
            sql.append(" AND e.amount_cents <= :amountMax");
            params.addValue("amountMax", amountMax);
        }
        sql.append(" ORDER BY t.occurred_at DESC, t.amount DESC");
        sql.append(" LIMIT :limit");
        try {
            return jdbcTemplate.query(sql.toString(), params, this::mapMatch);
        } catch (DataAccessException ex) {
            if (isMissingEmbeddingsTable(ex)) {
                warnMissingTableOnce(ex);
                return List.of();
            }
            throw ex;
        }
    }

    private EmbeddingMatch mapMatch(ResultSet rs, int rowNum) throws SQLException {
        UUID txId = rs.getObject("tx_id", UUID.class);
        UUID merchantId = rs.getObject("merchant_id", UUID.class);
        float[] embedding = parseEmbedding(rs.getString("embedding"));
        YearMonth month = YearMonth.from(rs.getTimestamp("occurred_at").toInstant().atZone(java.time.ZoneOffset.UTC));
        int amountCents = rs.getBigDecimal("amount").movePointRight(2).intValue();
        String category = rs.getString("category");
        return new EmbeddingMatch(txId, merchantId, embedding, month, amountCents, category);
    }

    private float[] parseEmbedding(String json) {
        if (json == null || json.isBlank() || json.equals("[]")) {
            return new float[0];
        }
        String trimmed = json.replace("[", "").replace("]", "").trim();
        if (trimmed.isEmpty()) {
            return new float[0];
        }
        String[] parts = trimmed.split(",");
        float[] vector = new float[parts.length];
        for (int i = 0; i < parts.length; i++) {
            vector[i] = Float.parseFloat(parts[i].trim());
        }
        return vector;
    }

    public record EmbeddingRecord(
            UUID txId,
            UUID userId,
            YearMonth month,
            String category,
            int amountCents,
            UUID merchantId,
            String merchantNormalized,
            float[] embedding
    ) {
    }

    public record EmbeddingMatch(
            UUID txId,
            UUID merchantId,
            float[] embedding,
            YearMonth month,
            int amountCents,
            String category
    ) {
    }

    private boolean isMissingEmbeddingsTable(DataAccessException ex) {
        String message = ex.getMessage();
        if (message == null) {
            return false;
        }
        String normalized = message.toLowerCase();
        if (normalized.contains("relation \"tx_embeddings\" does not exist")
                || normalized.contains("relation 'tx_embeddings' does not exist")
                || normalized.contains("tx_embeddings does not exist")) {
            return true;
        }
        if (ex instanceof BadSqlGrammarException badSql) {
            String sqlState = badSql.getSQLException() != null ? badSql.getSQLException().getSQLState() : null;
            return "42P01".equals(sqlState);
        }
        return false;
    }

    private void warnMissingTableOnce(DataAccessException ex) {
        if (missingTableWarned.compareAndSet(false, true)) {
            log.warn("RAG embeddings table is missing; continuing without vector retrieval. reason={}", ex.getMessage());
        }
    }
}
