package com.safepocket.ledger.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * Early sanity diagnostics for the JDBC URL so misconfigured ECS task env vars
 * surface immediately (instead of a generic Hikari message later).
 */
@Component
@Profile("!test")
public class DataSourceDiagnostics {
    private static final Logger log = LoggerFactory.getLogger(DataSourceDiagnostics.class);

    @Value("${spring.datasource.url:}")
    private String jdbcUrl;

    @Value("${spring.datasource.username:}")
    private String username;

    @PostConstruct
    void validate() {
        String redactedUser = username == null || username.isBlank() ? "<none>" : username;
        log.info("DataSource diagnostics: url='{}' user='{}'", safe(jdbcUrl), redactedUser);
        if (jdbcUrl == null || jdbcUrl.isBlank()) {
            throw new IllegalStateException("spring.datasource.url is blank (ensure SPRING_DATASOURCE_URL is set)");
        }
        if (!jdbcUrl.startsWith("jdbc:postgresql://")) {
            throw new IllegalStateException("spring.datasource.url must start with 'jdbc:postgresql://' (actual='" + jdbcUrl + "')");
        }
        // Optionally encourage sslmode
        if (!jdbcUrl.contains("sslmode=")) {
            log.warn("JDBC url has no sslmode parameter; consider '?sslmode=require' for production");
        }
    }

    private String safe(String url) {
        if (url == null) return null;
        // Remove password query param if present
        return url.replaceAll("(?i)(password=)[^&]+", "$1***");
    }
}
