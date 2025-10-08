package com.safepocket.ledger.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

@ConfigurationProperties(prefix = "safepocket")
public record SafepocketProperties(
        Cognito cognito,
        Plaid plaid,
        Ai ai,
        Security security
) {

    @ConstructorBinding
    public SafepocketProperties {
        if (cognito == null) {
            throw new IllegalArgumentException("cognito configuration must be provided");
        }
        if (plaid == null) {
            throw new IllegalArgumentException("plaid configuration must be provided");
        }
        if (ai == null) {
            throw new IllegalArgumentException("ai configuration must be provided");
        }
        // security may be null for production defaults; handle via accessor method
    }

    public record Cognito(String issuer, String audience, Boolean enabled) {
        public Cognito {
            if (issuer == null || issuer.isBlank()) {
                throw new IllegalArgumentException("issuer must be provided");
            }
            if (audience == null || audience.isBlank()) {
                throw new IllegalArgumentException("audience must be provided");
            }
        }

        public boolean enabledFlag() {
            return enabled == null || enabled;
        }
    }

    public record Plaid(String clientId, String clientSecret, String redirectUri, String baseUrl, String environment, String webhookUrl, String webhookSecret) {
        public Plaid {
            if (clientId == null || clientId.isBlank()) {
                throw new IllegalArgumentException("clientId must be provided");
            }
            if (clientSecret == null || clientSecret.isBlank()) {
                throw new IllegalArgumentException("clientSecret must be provided");
            }
            if (redirectUri == null || redirectUri.isBlank()) {
                throw new IllegalArgumentException("redirectUri must be provided");
            }
            if (baseUrl == null || baseUrl.isBlank()) {
                throw new IllegalArgumentException("baseUrl must be provided");
            }
            if (environment == null || environment.isBlank()) {
                throw new IllegalArgumentException("environment must be provided");
            }
            // webhookUrl and webhookSecret are optional (may be null) for early sandbox stage
        }
    }

    public record Ai(String model, String endpoint, String apiKey, String snapshot) {
        public Ai {
            if (model == null || model.isBlank()) {
                throw new IllegalArgumentException("model must be provided");
            }
            if (endpoint == null || endpoint.isBlank()) {
                throw new IllegalArgumentException("endpoint must be provided");
            }
            // apiKey may be null/blank; when absent the app will use a deterministic fallback (no external calls)
            // snapshot is optional: used when primary alias (model) requires explicit snapshot access (e.g. gpt-5-nano-YYYY-MM-DD)
        }

        public String snapshotOrDefault() {
            return (snapshot != null && !snapshot.isBlank()) ? snapshot : model;
        }
    }

    public Security security() {
        return security != null ? security : new Security(null);
    }

    public record Security(String devJwtSecret) {
        public boolean hasDevJwtSecret() {
            return devJwtSecret != null && !devJwtSecret.isBlank();
        }
    }
}
