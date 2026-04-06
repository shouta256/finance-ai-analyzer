package com.safepocket.ledger.rag;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import com.safepocket.ledger.config.SafepocketProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
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
    private final boolean localPgvectorEnabled;
    private final AtomicBoolean missingTableWarned = new AtomicBoolean(false);
    private final AtomicBoolean missingPgvectorWarned = new AtomicBoolean(false);
    private final AtomicReference<Boolean> embeddingVectorColumnAvailable = new AtomicReference<>();

    @Autowired
    public TxEmbeddingRepository(
            NamedParameterJdbcTemplate jdbcTemplate,
            EmbeddingService embeddingService,
            SafepocketProperties properties
    ) {
        this(jdbcTemplate, embeddingService, properties.rag().localPgvectorEnabledFlag());
    }

    TxEmbeddingRepository(NamedParameterJdbcTemplate jdbcTemplate, EmbeddingService embeddingService, boolean localPgvectorEnabled) {
        this.jdbcTemplate = jdbcTemplate;
        this.embeddingService = embeddingService;
        this.localPgvectorEnabled = localPgvectorEnabled;
    }

    public void upsertBatch(List<EmbeddingRecord> records) {
        if (records.isEmpty()) {
            return;
        }
        String jsonbSql = """
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
        String pgvectorSql = """
                INSERT INTO tx_embeddings (tx_id, user_id, yyyymm, category, amount_cents, merchant_id, merchant_normalized, embedding, embedding_vector, updated_at)
                VALUES (:txId, :userId, :yyyymm, :category, :amountCents, :merchantId, :merchantNormalized, :embedding::jsonb, CAST(:embeddingVector AS vector), now())
                ON CONFLICT (tx_id)
                DO UPDATE SET
                    category = excluded.category,
                    amount_cents = excluded.amount_cents,
                    yyyymm = excluded.yyyymm,
                    merchant_id = excluded.merchant_id,
                    merchant_normalized = excluded.merchant_normalized,
                    embedding = excluded.embedding,
                    embedding_vector = excluded.embedding_vector,
                    updated_at = now();
                """;
        List<MapSqlParameterSource> params = new ArrayList<>(records.size());
        for (EmbeddingRecord record : records) {
            String embeddingSql = record.embedding() != null ? embeddingService.formatForSql(record.embedding()) : "[]";
            MapSqlParameterSource param = new MapSqlParameterSource()
                    .addValue("txId", record.txId())
                    .addValue("userId", record.userId())
                    .addValue("yyyymm", record.month().toString())
                    .addValue("category", record.category())
                    .addValue("amountCents", record.amountCents())
                    .addValue("merchantId", record.merchantId())
                    .addValue("merchantNormalized", record.merchantNormalized())
                    .addValue("embedding", embeddingSql)
                    .addValue("embeddingVector", embeddingSql);
            params.add(param);
        }
        if (shouldUsePgvector()) {
            try {
                jdbcTemplate.batchUpdate(pgvectorSql, params.toArray(MapSqlParameterSource[]::new));
                return;
            } catch (DataAccessException ex) {
                if (isMissingEmbeddingsTable(ex)) {
                    warnMissingTableOnce(ex);
                    return;
                }
                if (isMissingPgvectorSupport(ex)) {
                    warnMissingPgvectorOnce(ex);
                    embeddingVectorColumnAvailable.set(false);
                } else {
                    throw ex;
                }
            }
        }
        try {
            jdbcTemplate.batchUpdate(jsonbSql, params.toArray(MapSqlParameterSource[]::new));
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
        if (shouldUsePgvector() && queryVector != null && queryVector.length > 0) {
            try {
                return findNearestWithPgvector(userId, queryVector, from, to, categories, amountMin, amountMax, limit);
            } catch (DataAccessException ex) {
                if (isMissingEmbeddingsTable(ex)) {
                    warnMissingTableOnce(ex);
                    return List.of();
                }
                if (isMissingPgvectorSupport(ex)) {
                    warnMissingPgvectorOnce(ex);
                    embeddingVectorColumnAvailable.set(false);
                } else {
                    throw ex;
                }
            }
        }
        return findNearestFallback(userId, from, to, categories, amountMin, amountMax, limit);
    }

    private List<EmbeddingMatch> findNearestWithPgvector(
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
                  AND e.embedding_vector IS NOT NULL
                """);
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("queryVector", embeddingService.formatForSql(queryVector))
                .addValue("limit", limit);
        appendFilters(sql, params, from, to, categories, amountMin, amountMax);
        sql.append(" ORDER BY e.embedding_vector <=> CAST(:queryVector AS vector), t.occurred_at DESC, t.amount DESC");
        sql.append(" LIMIT :limit");
        return jdbcTemplate.query(sql.toString(), params, this::mapMatch);
    }

    private List<EmbeddingMatch> findNearestFallback(
            UUID userId,
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
        appendFilters(sql, params, from, to, categories, amountMin, amountMax);
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

    private void appendFilters(
            StringBuilder sql,
            MapSqlParameterSource params,
            LocalDate from,
            LocalDate to,
            List<String> categories,
            Integer amountMin,
            Integer amountMax
    ) {
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

    private boolean shouldUsePgvector() {
        return localPgvectorEnabled && embeddingVectorColumnExists();
    }

    private boolean embeddingVectorColumnExists() {
        Boolean cached = embeddingVectorColumnAvailable.get();
        if (cached != null) {
            return cached;
        }
        boolean exists;
        try {
            Boolean columnExists = jdbcTemplate.queryForObject(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'tx_embeddings'
                          AND column_name = 'embedding_vector'
                    )
                    """,
                    new MapSqlParameterSource(),
                    Boolean.class
            );
            exists = Boolean.TRUE.equals(columnExists);
        } catch (DataAccessException ex) {
            exists = false;
        }
        embeddingVectorColumnAvailable.compareAndSet(null, exists);
        return exists;
    }

    private boolean isMissingPgvectorSupport(DataAccessException ex) {
        String message = ex.getMessage();
        if (message != null) {
            String normalized = message.toLowerCase();
            if (normalized.contains("type \"vector\" does not exist")
                    || normalized.contains("column \"embedding_vector\" does not exist")
                    || normalized.contains("operator does not exist: vector")
                    || normalized.contains("vector_cosine_ops")) {
                return true;
            }
        }
        if (ex instanceof BadSqlGrammarException badSql) {
            String sqlState = badSql.getSQLException() != null ? badSql.getSQLException().getSQLState() : null;
            return "42703".equals(sqlState) || "42704".equals(sqlState) || "42883".equals(sqlState);
        }
        return false;
    }

    private void warnMissingPgvectorOnce(DataAccessException ex) {
        if (missingPgvectorWarned.compareAndSet(false, true)) {
            log.warn("Local pgvector search is unavailable; falling back to JSONB embeddings. reason={}", ex.getMessage());
        }
    }
}
