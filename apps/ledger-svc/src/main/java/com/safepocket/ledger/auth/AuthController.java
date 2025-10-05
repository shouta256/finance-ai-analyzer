package com.safepocket.ledger.auth;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.safepocket.ledger.config.SafepocketProperties;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {

    private final SafepocketProperties properties;

    public AuthController(SafepocketProperties properties) {
        this.properties = properties;
    }

    public record LoginRequest(@JsonProperty("username") String username, @JsonProperty("password") String password) {}

    @PostMapping(path = "/login", consumes = "application/json", produces = "application/json")
    public ResponseEntity<?> login(@RequestBody LoginRequest request) {
        // Simple dev-only auth: accept any non-blank username/password. In production, integrate Cognito/OIDC.
        if (request == null || !StringUtils.hasText(request.username()) || !StringUtils.hasText(request.password())) {
            return ResponseEntity.badRequest().body(Map.of("error", "INVALID_CREDENTIALS"));
        }

        if (!properties.security().hasDevJwtSecret()) {
            return ResponseEntity.status(501).body(Map.of("error", "DEV_LOGIN_DISABLED"));
        }

        String secret = properties.security().devJwtSecret();
        String subject = request.username();
        long now = Instant.now().getEpochSecond();
        long exp = now + 3600; // 1 hour

        String header = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = String.format("{\"sub\":\"%s\",\"iat\":%d,\"exp\":%d}", subject, now, exp);
        String payloadEnc = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        String signature = hmacSha256(header + "." + payloadEnc, secret);
        String token = header + "." + payloadEnc + "." + signature;

        ResponseCookie cookie = ResponseCookie.from("safepocket_token", token)
                .httpOnly(true)
                .secure(true)
                .sameSite("Lax")
                .path("/")
                .domain(".shota256.me")
                .maxAge(3600)
                .build();

        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie.toString())
                .body(Map.of("accessToken", token, "tokenType", "Bearer", "expiresIn", 3600));
    }

    private String hmacSha256(String data, String secret) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] raw = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to sign token", e);
        }
    }
}
