package com.safepocket.ledger.security;

import com.safepocket.ledger.config.SafepocketProperties;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

@Service
public class JwtIssuerService {
    private final SecretKey key;
    private final boolean enabled;

    public JwtIssuerService(SafepocketProperties properties) {
        String secret = properties.security().devJwtSecret();
        this.enabled = properties.security().hasDevJwtSecret();
        if (enabled) {
            byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
            if (bytes.length < 32) { // HS256 needs at least 256-bit secret
                throw new IllegalStateException("devJwtSecret must be at least 32 bytes");
            }
            this.key = Keys.hmacShaKeyFor(bytes);
        } else {
            this.key = null;
        }
    }

    public boolean isEnabled() { return enabled; }

    public String issue(UUID userId, long ttlSeconds) {
        if (!enabled) {
            throw new IllegalStateException("Dev JWT issuance not enabled (Cognito mode or missing secret)");
        }
        Instant now = Instant.now();
    return Jwts.builder()
                .setSubject(userId.toString())
                .claim("scope", "user")
                // Align with frontend dev token expectations (middleware may inspect iss/aud)
                .setIssuer("safepocket-dev")
                .setAudience("safepocket-web")
                .setIssuedAt(Date.from(now))
                .setExpiration(Date.from(now.plusSeconds(ttlSeconds)))
        .signWith(key)
                .compact();
    }
}
