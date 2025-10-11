package com.safepocket.ledger.plaid;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.safepocket.ledger.config.SafepocketProperties;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Minimal Plaid API client (Stage1 Sandbox) supporting link token creation and public token exchange.
 * Uses blocking calls (toEntity) for simplicity; can be reactive later if needed.
 */
@Component
public class PlaidClient {
    private static final Logger log = LoggerFactory.getLogger(PlaidClient.class);

    private final WebClient webClient;
    private final SafepocketProperties properties;

    public PlaidClient(SafepocketProperties properties) {
        this.properties = properties;
        this.webClient = WebClient.builder()
                .baseUrl(properties.plaid().baseUrl())
                .defaultHeader("Content-Type", MediaType.APPLICATION_JSON_VALUE)
                .build();
    }

    public LinkTokenCreateResponse createLinkToken(String userId) {
        var bodyBuilder = new java.util.LinkedHashMap<String, Object>();
        bodyBuilder.put("client_id", properties.plaid().clientId());
        bodyBuilder.put("secret", properties.plaid().clientSecret());
        bodyBuilder.put("client_name", "Safepocket");
        bodyBuilder.put("language", "en");
        bodyBuilder.put("country_codes", new String[]{"US"});
        bodyBuilder.put("user", Map.of("client_user_id", userId));
        bodyBuilder.put("products", new String[]{"transactions"});
        if (properties.plaid().hasRedirectUri()) {
            bodyBuilder.put("redirect_uri", properties.plaid().redirectUri());
        }
        if (properties.plaid().webhookUrl() != null && !properties.plaid().webhookUrl().isBlank()) {
            bodyBuilder.put("webhook", properties.plaid().webhookUrl());
        }
        var body = bodyBuilder;
        return webClient.post().uri("/link/token/create")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(LinkTokenCreateResponse.class)
                .doOnError(e -> log.error("Plaid link token create failed", e))
                .block();
    }

    public ItemPublicTokenExchangeResponse exchangePublicToken(String publicToken) {
        var body = Map.of(
                "client_id", properties.plaid().clientId(),
                "secret", properties.plaid().clientSecret(),
                "public_token", publicToken
        );
        return webClient.post().uri("/item/public_token/exchange")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(ItemPublicTokenExchangeResponse.class)
                .doOnError(e -> log.error("Plaid public token exchange failed", e))
                .block();
    }

    public TransactionsGetResponse getTransactions(String accessToken, String startDate, String endDate, int count) {
        var body = new java.util.LinkedHashMap<String, Object>();
        body.put("client_id", properties.plaid().clientId());
        body.put("secret", properties.plaid().clientSecret());
        body.put("access_token", accessToken);
        body.put("start_date", startDate);
        body.put("end_date", endDate);
        body.put("options", Map.of("count", count));
        return webClient.post().uri("/transactions/get")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(TransactionsGetResponse.class)
                .doOnError(e -> log.error("Plaid transactions get failed", e))
                .block();
    }

    // --- Response DTOs --- //
    public record LinkTokenCreateResponse(
            @JsonProperty("link_token") String linkToken,
            @JsonProperty("expiration") String expiration,
            @JsonProperty("request_id") String requestId
    ) {}

    public record ItemPublicTokenExchangeResponse(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("item_id") String itemId,
            @JsonProperty("request_id") String requestId
    ) {}

    public record TransactionsGetResponse(
            @JsonProperty("transactions") java.util.List<PlaidTransaction> transactions,
            @JsonProperty("request_id") String requestId
    ) {
        public record PlaidTransaction(
                @JsonProperty("name") String name,
                @JsonProperty("merchant_name") String merchantName,
                @JsonProperty("amount") java.math.BigDecimal amount,
                @JsonProperty("iso_currency_code") String currency,
                @JsonProperty("date") String date,
                @JsonProperty("pending") boolean pending
        ) {}
    }

        // --- Webhook verification key (JWT JWK) ---
        public record WebhookVerificationKeyResponse(Key key, String requestId) {
            public record Key(String alg, String crv, String kid, String kty, String use, String x, String y, Long created_at, Long expired_at) {}
        }

        public WebhookVerificationKeyResponse getWebhookVerificationKey(String keyId) {
        var body = Map.of(
                "client_id", properties.plaid().clientId(),
                "secret", properties.plaid().clientSecret(),
                "key_id", keyId
        );
        return webClient.post().uri("/webhook_verification_key/get")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(body)
                    .retrieve()
                    .bodyToMono(WebhookVerificationKeyResponse.class)
                    .doOnError(e -> log.error("Plaid webhook verification key fetch failed", e))
                    .block();
        }
}
