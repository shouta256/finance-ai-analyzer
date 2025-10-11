package com.safepocket.ledger.config;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class StartupDiagnostics {
    private static final Logger log = LoggerFactory.getLogger(StartupDiagnostics.class);
    private final SafepocketProperties props;

    public StartupDiagnostics(SafepocketProperties props) {
        this.props = props;
    }

    @PostConstruct
    void logConfig() {
        // Avoid logging full secrets; only structural info.
        boolean cognitoEnabled = props.cognito().enabledFlag();
        String issuer = props.cognito().issuer();
        String audience = props.cognito().audience();
        boolean hasDevSecret = props.security().hasDevJwtSecret();
        log.info("Startup diagnostics: cognitoEnabled={}, issuer='{}', audience='{}', hasDevSecret={}, env(SAFEPOCKET_USE_COGNITO)='{}'",
                cognitoEnabled, issuer, audience, hasDevSecret, System.getenv("SAFEPOCKET_USE_COGNITO"));

        var plaid = props.plaid();
        String clientIdTail = plaid.clientId() != null && plaid.clientId().length() > 4
                ? plaid.clientId().substring(plaid.clientId().length() - 4) : "";
        log.info("Plaid config: env='{}', baseUrl='{}', clientId='***{}', redirectUriPresent={}",
                plaid.environment(), plaid.baseUrl(), clientIdTail, plaid.redirectUri() != null && !plaid.redirectUri().isBlank());
    }
}
