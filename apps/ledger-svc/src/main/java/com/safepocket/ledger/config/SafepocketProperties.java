package com.safepocket.ledger.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

@ConfigurationProperties(prefix = "safepocket")
public record SafepocketProperties(
        Cognito cognito,
        Plaid plaid,
        Ai ai,
        Security security,
        Rag rag
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
        if (rag == null) {
            throw new IllegalArgumentException("rag configuration must be provided");
        }
        // security may be null for production defaults; handle via accessor method
    }

    public record Cognito(
            String issuer,
            String audience,
            Boolean enabled,
            String domain,
            String clientId,
            String clientIdWeb,
            String clientIdNative,
            String clientSecret,
            String redirectUri
    ) {
        public Cognito {
            boolean enabledValue = enabled == null || enabled;
            if (enabledValue) {
                if (issuer == null || issuer.isBlank()) {
                    throw new IllegalArgumentException("issuer must be provided");
                }
                // Compute effective clientId if not provided: prefer specific web/native ids, else derive from audience
                if (clientId == null || clientId.isBlank()) {
                    if (clientIdWeb != null && !clientIdWeb.isBlank()) {
                        clientId = clientIdWeb;
                    } else if (clientIdNative != null && !clientIdNative.isBlank()) {
                        clientId = clientIdNative;
                    }
                }
                // Compute audience if missing: join available client ids (web,native,clientId) as comma list
                if (audience == null || audience.isBlank()) {
                    StringBuilder aud = new StringBuilder();
                    if (clientIdWeb != null && !clientIdWeb.isBlank()) aud.append(clientIdWeb);
                    if (clientIdNative != null && !clientIdNative.isBlank()) {
                        if (aud.length() > 0) aud.append(",");
                        aud.append(clientIdNative);
                    }
                    if ((clientId == null || clientId.isBlank()) && aud.length() == 0) {
                        throw new IllegalArgumentException("audience must be provided or derived from client ids");
                    }
                    if (aud.length() == 0) {
                        aud.append(clientId);
                    }
                    audience = aud.toString();
                }
                // Ensure clientId has a value at this point
                if (clientId == null || clientId.isBlank()) {
                    // choose first in audience list
                    clientId = audience.contains(",") ? audience.split("\\s*,\\s*")[0] : audience;
                }
            } else {
                // When Cognito disabled, avoid strict validation; set safe defaults to avoid NPEs in diagnostics
                if (audience == null) audience = "";
                if (clientId == null) clientId = "";
            }
        }

        public boolean enabledFlag() {
            return enabled == null || enabled;
        }

        public boolean hasDomain() {
            return domain != null && !domain.isBlank();
        }

        public boolean hasClientSecret() {
            return clientSecret != null && !clientSecret.isBlank();
        }

        public boolean hasRedirectUri() {
            return redirectUri != null && !redirectUri.isBlank();
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
            if (baseUrl == null || baseUrl.isBlank()) {
                throw new IllegalArgumentException("baseUrl must be provided");
            }
            if (environment == null || environment.isBlank()) {
                throw new IllegalArgumentException("environment must be provided");
            }
            // webhookUrl and webhookSecret are optional (may be null) for early sandbox stage
        }

        public boolean hasRedirectUri() {
            return redirectUri != null && !redirectUri.isBlank();
        }
    }

    public record Ai(String provider, String model, String endpoint, String apiKey, String snapshot) {
        public Ai {
            // provider optional; defaults to openai
            if (model == null || model.isBlank()) {
                throw new IllegalArgumentException("model must be provided");
            }
            if (endpoint == null || endpoint.isBlank()) {
                throw new IllegalArgumentException("endpoint must be provided");
            }
            // apiKey may be null/blank; when absent the app will use a deterministic fallback (no external calls)
            // snapshot is optional: used when primary alias (model) requires explicit snapshot access (e.g. gpt-5-nano-YYYY-MM-DD)
        }

        public String providerOrDefault() {
            return (provider != null && !provider.isBlank()) ? provider.toLowerCase() : "openai";
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

    public record Rag(String vectorProvider, String embeddingModel, Integer maxRows, Integer embedDimension) {
        public Rag {
            if (vectorProvider == null || vectorProvider.isBlank()) {
                throw new IllegalArgumentException("vectorProvider must be provided");
            }
            if (embeddingModel == null || embeddingModel.isBlank()) {
                throw new IllegalArgumentException("embeddingModel must be provided");
            }
            if (maxRows == null || maxRows <= 0) {
                throw new IllegalArgumentException("maxRows must be positive");
            }
            if (embedDimension == null || embedDimension <= 0) {
                throw new IllegalArgumentException("embedDimension must be positive");
            }
        }
    }
}
