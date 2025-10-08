package com.safepocket.ledger.plaid;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.safepocket.ledger.config.SafepocketProperties;
import java.time.Instant;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

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
        bodyBuilder.put("redirect_uri", properties.plaid().redirectUri());
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
}
