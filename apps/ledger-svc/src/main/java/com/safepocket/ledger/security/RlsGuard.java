package com.safepocket.ledger.security;

import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
public class RlsGuard {

    private static final Logger log = LoggerFactory.getLogger(RlsGuard.class);
    private final DataSource dataSource;

    public RlsGuard(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public void setAppsecUser(UUID userId) {
        if (userId == null) {
            throw new IllegalArgumentException("User id is required for RLS");
        }
        var connection = DataSourceUtils.getConnection(dataSource);
        try (Statement statement = connection.createStatement()) {
            statement.execute("SET LOCAL appsec.user_id = '" + userId + "'");
        } catch (SQLException ex) {
            log.warn("Failed to set appsec.user_id on connection: {}", ex.getMessage());
        } finally {
            DataSourceUtils.releaseConnection(connection, dataSource);
        }
    }
}
