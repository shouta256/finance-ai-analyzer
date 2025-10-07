package com.safepocket.ledger.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.stream.Collectors;

/**
 * Optional bootstrap that applies the seed schema/data (idempotent) when the database
 * has not yet been initialized (transactions table missing) and the feature flag is enabled.
 * This is a temporary operational convenience until Flyway/Liquibase is introduced.
 * Enable with environment variable SAFEPOCKET_DB_BOOTSTRAP=true
 */
@Component
public class DatabaseBootstrap {
    private static final Logger log = LoggerFactory.getLogger(DatabaseBootstrap.class);

    private final DataSource dataSource;
    private final boolean enabled;

    public DatabaseBootstrap(DataSource dataSource,
                             @Value("${safepocket.db.bootstrap-enabled:false}") boolean enabled) {
        this.dataSource = dataSource;
        this.enabled = enabled;
    }

    @PostConstruct
    void maybeBootstrap() {
        if (!enabled) {
            log.info("DB bootstrap disabled (safepocket.db.bootstrap-enabled=false)");
            return;
        }
        try (Connection conn = dataSource.getConnection()) {
            if (transactionsTableExists(conn)) {
                log.info("DB bootstrap skipped: schema already present (transactions table exists)");
                return;
            }
            log.warn("DB bootstrap starting: applying seed schema/data (one-time)");
            String sql = loadSeedSql();
            int applied = 0;
            for (String stmt : splitStatements(sql)) {
                String trimmed = stmt.trim();
                if (trimmed.isEmpty()) continue;
                try (Statement s = conn.createStatement()) {
                    s.execute(trimmed);
                    applied++;
                } catch (Exception ex) {
                    // Ignore benign extension permission errors; fail loudly otherwise
                    if (trimmed.toLowerCase().startsWith("create extension") ) {
                        log.warn("Ignoring extension creation failure (likely insufficient privilege): {} -> {}", trimmed, ex.getMessage());
                    } else {
                        log.error("Failed executing bootstrap statement: {}", trimmed, ex);
                        throw ex;
                    }
                }
            }
            log.info("DB bootstrap completed: {} statements applied", applied);
        } catch (Exception e) {
            // Do not prevent application from starting; operations can inspect logs
            log.error("DB bootstrap failed (application will continue to start)", e);
        }
    }

    private boolean transactionsTableExists(Connection conn) {
        try (PreparedStatement ps = conn.prepareStatement(
                "select 1 from information_schema.tables where table_name = 'transactions' and table_schema = 'public'")) {
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next();
            }
        } catch (Exception e) {
            log.warn("Could not check for existing tables: {}", e.getMessage());
            return false; // attempt bootstrap anyway
        }
    }

    private String loadSeedSql() throws Exception {
        ClassPathResource res = new ClassPathResource("db/bootstrap/seed.sql");
        try (BufferedReader br = new BufferedReader(new InputStreamReader(res.getInputStream(), StandardCharsets.UTF_8))) {
            return br.lines().collect(Collectors.joining("\n"));
        }
    }

    private Iterable<String> splitStatements(String sql) {
        // Simple split by semicolon; seed.sql contains no procedural blocks.
        return java.util.Arrays.asList(sql.split(";"));
    }
}
