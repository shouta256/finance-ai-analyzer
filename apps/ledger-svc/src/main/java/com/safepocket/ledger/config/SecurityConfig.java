package com.safepocket.ledger.config;

import com.safepocket.ledger.security.AuthenticatedUserFilter;
import com.safepocket.ledger.security.TraceIdFilter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.context.annotation.Bean;
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

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            TraceIdFilter traceIdFilter,
            JwtAuthenticationConverter jwtAuthenticationConverter,
            AuthenticatedUserFilter authenticatedUserFilter
    ) throws Exception {
        http
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(registry -> registry
                        .requestMatchers(HttpMethod.POST, "/webhook/plaid").permitAll()
                        .requestMatchers("/actuator/health").permitAll()
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
        if (properties.security().hasDevJwtSecret()) {
            SecretKeySpec key = new SecretKeySpec(properties.security().devJwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(key)
                    .macAlgorithm(MacAlgorithm.HS256)
                    .build();
            decoder.setJwtValidator(token -> OAuth2TokenValidatorResult.success());
            return decoder;
        }

        if (!properties.cognito().enabledFlag()) {
            throw new IllegalStateException("Cognito JWT verification disabled and no dev secret provided");
        }

        NimbusJwtDecoder decoder = (NimbusJwtDecoder) JwtDecoders.fromIssuerLocation(properties.cognito().issuer());
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
                JwtValidators.createDefaultWithIssuer(properties.cognito().issuer()),
                audienceValidator(properties)
        ));
        return decoder;
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
