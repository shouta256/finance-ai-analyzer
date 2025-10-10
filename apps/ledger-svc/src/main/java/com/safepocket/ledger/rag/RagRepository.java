package com.safepocket.ledger.rag;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class RagRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;

    public RagRepository(NamedParameterJdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<TransactionSlice> fetchTransactions(UUID userId, List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        String sql = """
                SELECT t.id,
                       t.occurred_at,
                       t.amount,
                       t.category,
                       coalesce(t.description, '') AS description,
                       m.id AS merchant_id,
                       m.name AS merchant_name
                FROM transactions t
                JOIN merchants m ON t.merchant_id = m.id
                WHERE t.user_id = :userId
                  AND t.id IN (:ids)
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("ids", ids);
        return jdbcTemplate.query(sql, params, this::mapTransactionSlice);
    }

    public MonthlySummary loadMonthlySummary(UUID userId, YearMonth month) {
        Instant from = month.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        Instant to = month.plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("from", java.sql.Timestamp.from(from))
                .addValue("to", java.sql.Timestamp.from(to));

                                Totals totals = jdbcTemplate.queryForObject("""
                                                                SELECT
                                                                                CAST(coalesce(sum(CASE WHEN amount > 0 THEN amount * 100 ELSE 0 END), 0) AS bigint) AS income_cents,
                                                                                CAST(coalesce(sum(CASE WHEN amount < 0 THEN amount * 100 ELSE 0 END), 0) AS bigint) AS expense_cents,
                                                                                coalesce(count(*), 0) AS txn_count
                                                                FROM transactions
                                                                WHERE user_id = :userId
                                                                        AND occurred_at >= :from
                                                                        AND occurred_at < :to
                                                                """, params, (rs, rowNum) -> new Totals(rs.getLong("income_cents"), rs.getLong("expense_cents"), rs.getInt("txn_count")));

        List<CategorySummary> categories = jdbcTemplate.query("""
                  SELECT category,
                          count(*) AS cnt,
                          CAST(sum(amount * 100) AS bigint) AS sum_cents,
                          CAST(avg(amount) * 100 AS bigint) AS avg_cents
                FROM transactions
                WHERE user_id = :userId
                  AND occurred_at >= :from
                  AND occurred_at < :to
                GROUP BY category
                ORDER BY sum_cents ASC
                """, params, (rs, rowNum) -> new CategorySummary(
                rs.getString("category"),
                rs.getInt("cnt"),
                rs.getLong("sum_cents"),
                rs.getLong("avg_cents")));

        List<MerchantSummary> merchants = jdbcTemplate.query("""
                  SELECT m.id AS merchant_id,
                          m.name AS merchant_name,
                          count(*) AS cnt,
                          CAST(sum(t.amount * 100) AS bigint) AS sum_cents
                FROM transactions t
                JOIN merchants m ON t.merchant_id = m.id
                WHERE t.user_id = :userId
                  AND t.occurred_at >= :from
                  AND t.occurred_at < :to
                GROUP BY m.id, m.name
                ORDER BY sum_cents ASC
                LIMIT 20
                """, params, (rs, rowNum) -> new MerchantSummary(
                rs.getObject("merchant_id", UUID.class),
                rs.getString("merchant_name"),
                rs.getInt("cnt"),
                rs.getLong("sum_cents")));

        return new MonthlySummary(totals, categories, merchants);
    }

    public List<AggregateBucket> aggregate(UUID userId, LocalDate from, LocalDate to, Granularity granularity) {
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("from", from != null ? java.sql.Timestamp.from(from.atStartOfDay(ZoneOffset.UTC).toInstant()) : null)
                .addValue("to", to != null ? java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()) : null);
        StringBuilder sql = new StringBuilder();
        sql.append("""
                SELECT
                """);
        switch (granularity) {
            case CATEGORY -> sql.append("""
                    t.category AS bucket_key,
                    t.category AS label,
                    """);
            case MERCHANT -> sql.append("""
                    m.id::text AS bucket_key,
                    m.name AS label,
                    """);
            case MONTH -> sql.append("""
                    to_char(date_trunc('month', t.occurred_at), 'YYYY-MM') AS bucket_key,
                    to_char(date_trunc('month', t.occurred_at), 'YYYY-MM') AS label,
                    """);
        }
        sql.append("""
                count(*) AS cnt,
                CAST(sum(t.amount * 100) AS bigint) AS sum_cents,
                CAST(avg(t.amount) * 100 AS bigint) AS avg_cents
                FROM transactions t
                """);
        if (granularity == Granularity.MERCHANT) {
            sql.append("JOIN merchants m ON t.merchant_id = m.id\n");
        }
        sql.append("WHERE t.user_id = :userId\n");
        if (from != null) {
            sql.append("  AND t.occurred_at >= :from\n");
        }
        if (to != null) {
            sql.append("  AND t.occurred_at < :to\n");
        }
        sql.append("GROUP BY bucket_key, label\n");
        sql.append("ORDER BY sum_cents ASC\n");

        return jdbcTemplate.query(sql.toString(), params, (rs, rowNum) -> new AggregateBucket(
                rs.getString("bucket_key"),
                rs.getString("label"),
                rs.getInt("cnt"),
                rs.getLong("sum_cents"),
                rs.getLong("avg_cents")
        ));
    }

    public List<TransactionSlice> findTransactionsForEmbedding(
            UUID userId,
            LocalDate from,
            LocalDate to,
            List<String> categories,
            Integer amountMin,
            Integer amountMax,
            int limit
    ) {
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("limit", limit);
        StringBuilder sql = new StringBuilder("""
                SELECT t.id,
                       t.occurred_at,
                       t.amount,
                       t.category,
                       coalesce(t.description, '') AS description,
                       m.id AS merchant_id,
                       m.name AS merchant_name
                FROM transactions t
                JOIN merchants m ON t.merchant_id = m.id
                WHERE t.user_id = :userId
                """);
        if (from != null) {
            sql.append("  AND t.occurred_at >= :from\n");
            params.addValue("from", java.sql.Timestamp.from(from.atStartOfDay(ZoneOffset.UTC).toInstant()));
        }
        if (to != null) {
            sql.append("  AND t.occurred_at < :to\n");
            params.addValue("to", java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()));
        }
        if (categories != null && !categories.isEmpty()) {
            sql.append("  AND t.category IN (:categories)\n");
            params.addValue("categories", categories);
        }
                if (amountMin != null) {
                        sql.append("  AND CAST(t.amount * 100 AS bigint) >= :amountMin\n");
                        params.addValue("amountMin", amountMin);
                }
                if (amountMax != null) {
                        sql.append("  AND CAST(t.amount * 100 AS bigint) <= :amountMax\n");
                        params.addValue("amountMax", amountMax);
                }
        sql.append("ORDER BY t.occurred_at DESC, t.amount DESC\n");
        sql.append("LIMIT :limit");
        return jdbcTemplate.query(sql.toString(), params, this::mapTransactionSlice);
    }

    public List<TimelinePoint> aggregateTimeline(UUID userId, LocalDate from, LocalDate to) {
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("from", from != null ? java.sql.Timestamp.from(from.atStartOfDay(ZoneOffset.UTC).toInstant()) : null)
                .addValue("to", to != null ? java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()) : null);
        StringBuilder sql = new StringBuilder("""
                SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS bucket,
                       count(*) AS cnt,
                       CAST(sum(amount * 100) AS bigint) AS sum_cents
                FROM transactions
                WHERE user_id = :userId
                """);
        if (from != null) {
            sql.append("  AND occurred_at >= :from\n");
        }
        if (to != null) {
            sql.append("  AND occurred_at < :to\n");
        }
        sql.append("""
                GROUP BY bucket
                ORDER BY bucket ASC
                """);
        return jdbcTemplate.query(sql.toString(), params, (rs, rowNum) -> new TimelinePoint(
                rs.getString("bucket"),
                rs.getInt("cnt"),
                rs.getLong("sum_cents")
        ));
    }

    private TransactionSlice mapTransactionSlice(ResultSet rs, int rowNum) throws SQLException {
        UUID id = rs.getObject("id", UUID.class);
        Instant occurredAt = rs.getTimestamp("occurred_at").toInstant();
        BigDecimal amount = rs.getBigDecimal("amount");
        String category = rs.getString("category");
        String description = rs.getString("description");
        UUID merchantId = rs.getObject("merchant_id", UUID.class);
        String merchantName = rs.getString("merchant_name");
        return new TransactionSlice(
                id,
                LocalDate.ofInstant(occurredAt, ZoneOffset.UTC),
                amount.movePointRight(2).intValue(),
                category,
                description,
                merchantId,
                merchantName
        );
    }

    public record TransactionSlice(
            UUID transactionId,
            LocalDate occurredOn,
            int amountCents,
            String category,
            String description,
            UUID merchantId,
            String merchantName
    ) {
    }

    public record Totals(long incomeCents, long expenseCents, int count) {
    }

    public record CategorySummary(String category, int count, long sumCents, long avgCents) {
    }

    public record MerchantSummary(UUID merchantId, String merchantName, int count, long sumCents) {
    }

    public record MonthlySummary(
            Totals totals,
            List<CategorySummary> categories,
            List<MerchantSummary> merchants
    ) {
    }

    public enum Granularity {
        CATEGORY, MERCHANT, MONTH
    }

    public record AggregateBucket(
            String key,
            String label,
            int count,
            long sumCents,
            long avgCents
    ) {
    }

    public record TimelinePoint(String bucket, int count, long sumCents) {
    }
}
