package com.safepocket.ledger.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.config.SafepocketProperties;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.springframework.web.reactive.function.client.WebClientResponseException;

@Service
public class CognitoAuthService {

    private static final Logger log = LoggerFactory.getLogger(CognitoAuthService.class);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(15);
    private static final String GRANT_AUTHORIZATION_CODE = "authorization_code";
    private static final String GRANT_REFRESH_TOKEN = "refresh_token";

    private final SafepocketProperties properties;
    private final ObjectMapper objectMapper;

    public CognitoAuthService(SafepocketProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public AuthTokenResult exchange(TokenExchangeRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Request body is required");
        }
        String grantType = normalizeGrantType(request.grantType());
        String baseUrl = resolveBaseUrl();
        String clientId = resolveClientId();

        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", grantType);
        form.add("client_id", clientId);

        if (GRANT_AUTHORIZATION_CODE.equals(grantType)) {
            handleAuthorizationCodeGrant(request, form);
        } else if (GRANT_REFRESH_TOKEN.equals(grantType)) {
            handleRefreshTokenGrant(request, form);
        } else {
            throw new IllegalArgumentException("Unsupported grantType: " + grantType);
        }

        String clientSecret = properties.cognito().hasClientSecret() ? properties.cognito().clientSecret() : null;

        WebClient client = WebClient.builder()
                .baseUrl(baseUrl)
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .build();

        try {
            CognitoTokenResponse response = client.post()
                    .uri("/oauth2/token")
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .headers(headers -> {
                        if (clientSecret != null && !clientSecret.isBlank()) {
                            headers.setBasicAuth(clientId, clientSecret, StandardCharsets.UTF_8);
                        }
                    })
                    .body(BodyInserters.fromFormData(form))
                    .retrieve()
                    .bodyToMono(CognitoTokenResponse.class)
                    .block(REQUEST_TIMEOUT);

            if (response == null) {
                throw new CognitoExchangeException(502, "Empty response from Cognito token endpoint");
            }

            Optional<UUID> userId = extractUserId(response.idToken(), response.accessToken());
            int expiresIn = response.expiresIn() != null ? response.expiresIn() : 3600;

            return new AuthTokenResult(
                    response.accessToken(),
                    response.idToken(),
                    response.refreshToken(),
                    expiresIn,
                    response.tokenType(),
                    response.scope(),
                    userId
            );
        } catch (WebClientResponseException ex) {
            log.warn("Cognito token exchange failed with status {}: {}", ex.getRawStatusCode(), safeBody(ex.getResponseBodyAsString()));
            throw new CognitoExchangeException(ex.getRawStatusCode(), ex.getResponseBodyAsString(), ex);
        } catch (WebClientRequestException ex) {
            log.warn("Cognito token exchange request failed: {}", ex.getMessage());
            throw new CognitoExchangeException(502, ex.getMessage(), ex);
        }
    }

    private void handleAuthorizationCodeGrant(TokenExchangeRequest request, MultiValueMap<String, String> form) {
        if (!StringUtils.hasText(request.code())) {
            throw new IllegalArgumentException("code is required for authorization_code grant");
        }
        String redirectUri = determineRedirectUri(request.redirectUri());
        form.add("code", request.code());
        form.add("redirect_uri", redirectUri);
        if (StringUtils.hasText(request.codeVerifier())) {
            form.add("code_verifier", request.codeVerifier());
        }
    }

    private void handleRefreshTokenGrant(TokenExchangeRequest request, MultiValueMap<String, String> form) {
        if (!StringUtils.hasText(request.refreshToken())) {
            throw new IllegalArgumentException("refreshToken is required for refresh_token grant");
        }
        form.add("refresh_token", request.refreshToken());
    }

    private String determineRedirectUri(String requestedRedirect) {
        if (StringUtils.hasText(requestedRedirect)) {
            return requestedRedirect;
        }
        if (properties.cognito().hasRedirectUri()) {
            return properties.cognito().redirectUri();
        }
        throw new IllegalArgumentException("redirectUri is required (supply in request or configure COGNITO_REDIRECT_URI)");
    }

    private String normalizeGrantType(String grantType) {
        if (!StringUtils.hasText(grantType)) {
            throw new IllegalArgumentException("grantType is required");
        }
        return grantType.trim().toLowerCase();
    }

    private String resolveClientId() {
        String clientId = properties.cognito().clientId();
        if (!StringUtils.hasText(clientId)) {
            throw new IllegalStateException("Cognito client ID not configured (set COGNITO_CLIENT_ID or COGNITO_AUDIENCE)");
        }
        return clientId;
    }

    private String resolveBaseUrl() {
        if (!properties.cognito().hasDomain()) {
            throw new IllegalStateException("Cognito domain not configured (set COGNITO_DOMAIN)");
        }
        String domain = properties.cognito().domain().trim();
        if (domain.startsWith("http://") || domain.startsWith("https://")) {
            return domain;
        }
        return "https://" + domain;
    }

    private Optional<UUID> extractUserId(String preferredToken, String fallbackToken) {
        return decodeSubject(preferredToken)
                .or(() -> decodeSubject(fallbackToken));
    }

    private Optional<UUID> decodeSubject(String token) {
        if (!StringUtils.hasText(token)) {
            return Optional.empty();
        }
        try {
            String[] parts = token.split("\\.");
            if (parts.length < 2) {
                return Optional.empty();
            }
            byte[] payload = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode node = objectMapper.readTree(payload);
            if (node.hasNonNull("sub")) {
                String sub = node.get("sub").asText();
                return Optional.of(UUID.fromString(sub));
            }
        } catch (Exception ex) {
            log.debug("Unable to decode subject from token: {}", ex.getMessage());
        }
        return Optional.empty();
    }

    private String safeBody(String body) {
        if (body == null) {
            return null;
        }
        return body.length() > 512 ? body.substring(0, 512) + "..." : body;
    }

    private record CognitoTokenResponse(
            @JsonProperty("access_token") String accessToken,
            @JsonProperty("id_token") String idToken,
            @JsonProperty("refresh_token") String refreshToken,
            @JsonProperty("expires_in") Integer expiresIn,
            @JsonProperty("token_type") String tokenType,
            String scope
    ) {
    }

    public record AuthTokenResult(
            String accessToken,
            String idToken,
            String refreshToken,
            int expiresIn,
            String tokenType,
            String scope,
            Optional<UUID> userId
    ) { }

    public static class CognitoExchangeException extends RuntimeException {
        private final int status;
        private final String responseBody;

        public CognitoExchangeException(int status, String responseBody) {
            super("Cognito token exchange failed with status " + status);
            this.status = status;
            this.responseBody = responseBody;
        }

        public CognitoExchangeException(int status, String responseBody, Throwable cause) {
            super("Cognito token exchange failed with status " + status, cause);
            this.status = status;
            this.responseBody = responseBody;
        }

        public int status() {
            return status;
        }

        public String responseBody() {
            return responseBody;
        }
    }

    public record TokenExchangeRequest(
            String grantType,
            String code,
            String redirectUri,
            String codeVerifier,
            String refreshToken
    ) { }
}
