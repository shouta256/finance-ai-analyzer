package com.safepocket.ledger.rag;

import com.safepocket.ledger.config.SafepocketProperties;
import java.sql.Connection;
import java.sql.SQLException;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@ConditionalOnProperty(name = "safepocket.rag.local-pgvector-enabled", havingValue = "true")
public class PgvectorLocalInitializer implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(PgvectorLocalInitializer.class);

    private final DataSource dataSource;
    private final JdbcTemplate jdbcTemplate;
    private final SafepocketProperties properties;

    public PgvectorLocalInitializer(DataSource dataSource, JdbcTemplate jdbcTemplate, SafepocketProperties properties) {
        this.dataSource = dataSource;
        this.jdbcTemplate = jdbcTemplate;
        this.properties = properties;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!isPostgresDatabase()) {
            log.info("Skipping local pgvector initialization because the active datasource is not PostgreSQL");
            return;
        }
        if (!isPgvectorAvailable()) {
            log.warn("Local pgvector support requested, but the vector extension is not available in this Postgres instance");
            return;
        }

        int dimension = properties.rag().embedDimension();
        jdbcTemplate.execute("CREATE EXTENSION IF NOT EXISTS vector");
        jdbcTemplate.execute("ALTER TABLE tx_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(" + dimension + ")");
        jdbcTemplate.execute("""
                UPDATE tx_embeddings
                SET embedding_vector = CAST(embedding::text AS vector)
                WHERE embedding_vector IS NULL
                  AND jsonb_typeof(embedding) = 'array'
                """);
        jdbcTemplate.execute("""
                CREATE INDEX IF NOT EXISTS tx_embeddings_embedding_vector_ivfflat_idx
                ON tx_embeddings USING ivfflat (embedding_vector vector_cosine_ops)
                WITH (lists = 100)
                """);
        jdbcTemplate.execute("ANALYZE tx_embeddings");
        log.info("Local pgvector support ready for tx_embeddings (dimension={})", dimension);
    }

    private boolean isPgvectorAvailable() {
        try {
            Integer count = jdbcTemplate.queryForObject(
                    "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'",
                    Integer.class
            );
            return count != null && count > 0;
        } catch (DataAccessException ex) {
            log.warn("Local pgvector support requested, but extension discovery failed: {}", ex.getMessage());
            return false;
        }
    }

    private boolean isPostgresDatabase() {
        try (Connection connection = dataSource.getConnection()) {
            String productName = connection.getMetaData().getDatabaseProductName();
            return productName != null && productName.toLowerCase().contains("postgres");
        } catch (SQLException ex) {
            log.warn("Unable to inspect datasource metadata for pgvector initialization: {}", ex.getMessage());
            return false;
        }
    }
}
