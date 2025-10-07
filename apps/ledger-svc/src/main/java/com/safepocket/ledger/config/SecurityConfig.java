package com.safepocket.ledger.config;

import com.safepocket.ledger.security.AuthenticatedUserFilter;
import com.safepocket.ledger.security.TraceIdFilter;
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
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;

@Configuration
public class SecurityConfig {
    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            TraceIdFilter traceIdFilter,
            JwtAuthenticationConverter jwtAuthenticationConverter,
            AuthenticatedUserFilter authenticatedUserFilter
    ) throws Exception {
    http
        .csrf(csrf -> csrf.disable())
        .cors(cors -> {})
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(registry -> registry
            // Allow all CORS preflight requests
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
            // Public / webhook endpoints
            .requestMatchers(HttpMethod.POST, "/webhook/plaid/**").permitAll()
            .requestMatchers(HttpMethod.POST, "/login").permitAll()
            .requestMatchers("/healthz").permitAll()
            .requestMatchers("/actuator/health/liveness").permitAll()
            // All other endpoints require authentication
            .anyRequest().authenticated()
        )
                .oauth2ResourceServer(resource -> resource.jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter)));

        http.addFilterBefore(traceIdFilter, UsernamePasswordAuthenticationFilter.class);
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
    JwtDecoder jwtDecoder(SafepocketProperties properties) {
        // Precedence change: if Cognito is enabled, ALWAYS use remote JWKS regardless of dev secret presence.
        if (properties.cognito().enabledFlag()) {
            log.info("Security: Using Cognito issuer {} audience {}", properties.cognito().issuer(), properties.cognito().audience());
            NimbusJwtDecoder decoder = (NimbusJwtDecoder) JwtDecoders.fromIssuerLocation(properties.cognito().issuer());
            decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                    JwtValidators.createDefaultWithIssuer(properties.cognito().issuer()),
                    audienceValidator(properties)
            ));
            return decoder;
        }
        // Fallback: Cognito disabled -> use dev shared secret if provided
        if (properties.security().hasDevJwtSecret()) {
            log.warn("Security: Cognito disabled; falling back to dev shared secret (NOT for production)");
            SecretKeySpec key = new SecretKeySpec(properties.security().devJwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
                    .macAlgorithm(MacAlgorithm.HS256)
                    .build();
            decoder.setJwtValidator(token -> OAuth2TokenValidatorResult.success());
            return decoder;
        }
        throw new IllegalStateException("Neither Cognito enabled nor dev JWT secret configured (set SAFEPOCKET_USE_COGNITO=true or provide SAFEPOCKET_DEV_JWT_SECRET)");
    }

    private OAuth2TokenValidator<Jwt> audienceValidator(SafepocketProperties properties) {
        return token -> {
            List<String> audiences = token.getAudience();
            if (audiences != null && audiences.contains(properties.cognito().audience())) {
                return OAuth2TokenValidatorResult.success();
            }
            return OAuth2TokenValidatorResult.failure(new OAuth2Error(
                    "invalid_token",
                    "Missing required audience", null
            ));
        };
    }
}
