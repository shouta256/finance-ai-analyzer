package com.safepocket.ledger.config;

import com.safepocket.ledger.security.AuthenticatedUserFilter;
import com.safepocket.ledger.security.TraceIdFilter;
import com.safepocket.ledger.security.CookieBearerTokenFilter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.context.annotation.Bean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import com.safepocket.ledger.security.JsonAuthErrorHandlers;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;

@Configuration
public class SecurityConfig {
    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            TraceIdFilter traceIdFilter,
            JwtAuthenticationConverter jwtAuthenticationConverter,
        AuthenticatedUserFilter authenticatedUserFilter,
        JsonAuthErrorHandlers jsonAuthErrorHandlers
    ) throws Exception {
    http
        .csrf(csrf -> csrf.disable())
        .cors(cors -> {})
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(registry -> registry
            // Allow all CORS preflight requests
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
            // Public / webhook endpoints
            .requestMatchers(HttpMethod.POST, "/webhook/plaid", "/webhook/plaid/**", "/plaid/webhook").permitAll()
            .requestMatchers(HttpMethod.POST, "/login").permitAll()
            .requestMatchers(HttpMethod.POST, "/dev/auth/login").permitAll()
            .requestMatchers(HttpMethod.POST, "/auth/token").permitAll()
            // Chat endpoint requires authentication (canonical + aliases)
            .requestMatchers(HttpMethod.POST, "/ai/chat", "/api/chat", "/chat").authenticated()
            .requestMatchers(HttpMethod.GET, "/ai/chat", "/api/chat", "/chat").authenticated()
            .requestMatchers("/healthz").permitAll()
            .requestMatchers("/actuator/health/liveness").permitAll()
            // All other endpoints require authentication
            .anyRequest().authenticated()
        )
        .oauth2ResourceServer(resource -> resource
            .authenticationEntryPoint(jsonAuthErrorHandlers)
            .accessDeniedHandler(jsonAuthErrorHandlers)
            .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter))
        );

    http.addFilterBefore(traceIdFilter, UsernamePasswordAuthenticationFilter.class);
    http.addFilterBefore(new CookieBearerTokenFilter(), BearerTokenAuthenticationFilter.class);
        http.addFilterAfter(authenticatedUserFilter, BearerTokenAuthenticationFilter.class);

        return http.build();
    }


    @Bean
    JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setPrincipalClaimName("sub");
        converter.setJwtGrantedAuthoritiesConverter(jwt -> List.of());
        return converter;
    }

    @Bean
    public JwtDecoder jwtDecoder(SafepocketProperties properties, Environment environment) {
        // Precedence change: if Cognito is enabled, ALWAYS use remote JWKS regardless of dev secret presence.
        if (properties.cognito().enabledFlag()) {
            log.info("Security: Using Cognito issuer {} audience {}", properties.cognito().issuer(), properties.cognito().audience());
            NimbusJwtDecoder cognitoDecoder = (NimbusJwtDecoder) JwtDecoders.fromIssuerLocation(properties.cognito().issuer());
            cognitoDecoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                    JwtValidators.createDefaultWithIssuer(properties.cognito().issuer()),
                    audienceValidator(properties)
            ));

            JwtDecoder activeDecoder = cognitoDecoder;
            boolean demoEnabled = "true".equalsIgnoreCase(System.getenv("SAFEPOCKET_ENABLE_DEMO_LOGIN"));
            if (properties.security().hasDevJwtSecret() && (!environment.acceptsProfiles(Profiles.of("prod")) || demoEnabled)) {
                log.info("Security: enabling dev JWT fallback decoder (non-prod or demo-mode enabled)");
                SecretKeySpec fallbackKey = new SecretKeySpec(properties.security().devJwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
                NimbusJwtDecoder fallbackDecoder = NimbusJwtDecoder.withSecretKey(fallbackKey)
                        .macAlgorithm(MacAlgorithm.HS256)
                        .build();
                fallbackDecoder.setJwtValidator(token -> OAuth2TokenValidatorResult.success());

                activeDecoder = token -> {
                    try {
                        return cognitoDecoder.decode(token);
                    } catch (JwtException ex) {
                        if (!looksLikeSignatureMismatch(ex)) {
                            throw ex;
                        }
                        log.debug("Security: Cognito validation failed with '{}'; attempting dev fallback", ex.getMessage());
                        return fallbackDecoder.decode(token);
                    }
                };
            }

            return activeDecoder;
        }
        // Fallback: Cognito disabled -> use dev shared secret if provided (only outside prod profile or if demo enabled)
        boolean demoEnabled = "true".equalsIgnoreCase(System.getenv("SAFEPOCKET_ENABLE_DEMO_LOGIN"));
        if (properties.security().hasDevJwtSecret() && (!environment.acceptsProfiles(Profiles.of("prod")) || demoEnabled)) {
            log.warn("Security: Cognito disabled; falling back to dev shared secret (Demo Mode or Non-Prod)");
            SecretKeySpec key = new SecretKeySpec(properties.security().devJwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
                    .macAlgorithm(MacAlgorithm.HS256)
                    .build();
            decoder.setJwtValidator(token -> OAuth2TokenValidatorResult.success());
            return decoder;
        }
        // Test convenience: if running under 'test' Spring profile, generate an ephemeral secret automatically
        if (environment.acceptsProfiles(Profiles.of("test"))) {
            log.warn("Security: Generating ephemeral test JWT secret (no Cognito/dev secret provided)");
            byte[] random = java.util.UUID.randomUUID().toString().replace("-", "").substring(0,32).getBytes(StandardCharsets.UTF_8);
            SecretKeySpec key = new SecretKeySpec(random, "HmacSHA256");
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
            decoder.setJwtValidator(token -> OAuth2TokenValidatorResult.success());
            return decoder;
        }
        throw new IllegalStateException("Neither Cognito enabled nor dev JWT secret configured (set SAFEPOCKET_USE_COGNITO=true or provide SAFEPOCKET_DEV_JWT_SECRET)");
    }

    private OAuth2TokenValidator<Jwt> audienceValidator(SafepocketProperties properties) {
        // Support comma-separated list of allowed audiences in the COGNITO_AUDIENCE env (first = primary)
        List<String> allowed = List.of(properties.cognito().audience().split(","))
                .stream()
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
        return token -> {
            List<String> tokenAud = token.getAudience();
            // Cognito access tokens often omit aud and instead have client_id + token_use=access
            String clientId = token.getClaimAsString("client_id");
            String tokenUse = token.getClaimAsString("token_use");
            if (tokenAud != null && !tokenAud.isEmpty()) {
                for (String a : tokenAud) {
                    if (allowed.contains(a)) {
                        return OAuth2TokenValidatorResult.success();
                    }
                }
            } else {
                // Fall back to client_id when aud absent
                if (clientId != null && allowed.contains(clientId) && "access".equals(tokenUse)) {
                    return OAuth2TokenValidatorResult.success();
                }
            }
            log.warn("JWT audience/client mismatch tokenAud={} client_id={} token_use={} allowed={} traceId={}",
                    tokenAud, clientId, tokenUse, allowed,
                    com.safepocket.ledger.security.RequestContextHolder.get().map(c -> c.traceId()).orElse(null));
            return OAuth2TokenValidatorResult.failure(new OAuth2Error(
                    "invalid_token",
                    "Missing required audience or client_id (tokenAud=" + tokenAud + ", client_id=" + clientId + ", allowed=" + allowed + ")",
                    null
            ));
        };
    }

    private boolean looksLikeSignatureMismatch(JwtException ex) {
        String message = ex.getMessage();
        if (message == null) {
            return false;
        }
        String normalized = message.toLowerCase();
        return normalized.contains("invalid signature")
                || normalized.contains("mac check failed")
                || normalized.contains("another algorithm expected")
                || normalized.contains("no matching key");
    }
}
