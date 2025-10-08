package com.safepocket.ledger.controller;

import com.safepocket.ledger.security.JwtIssuerService;
import org.springframework.http.HttpHeaders;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.context.annotation.Profile;

import java.time.Duration;
import java.util.UUID;

@RestController
@RequestMapping("/dev/auth")
@Profile("!prod") // Available in any non-prod profile (e.g. default, local, test)
public class DevAuthController {
    private static final Logger log = LoggerFactory.getLogger(DevAuthController.class);

    private final JwtIssuerService issuerService;

    public DevAuthController(JwtIssuerService issuerService) {
        this.issuerService = issuerService;
    }

    public record LoginRequest(String userId) {}
    public record LoginResponse(String token, UUID userId, long expiresInSeconds) {}

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody(required = false) LoginRequest body) {
        if (!issuerService.isEnabled()) {
            return ResponseEntity.status(404).body(java.util.Map.of("error", "dev auth disabled"));
        }
        log.debug("[dev-auth] issuing dev token (body userId={})", body != null ? body.userId() : null);
        UUID userUuid;
        if (body != null && body.userId() != null && !body.userId().isBlank()) {
            try { userUuid = UUID.fromString(body.userId()); } catch (Exception e) { return ResponseEntity.badRequest().body(java.util.Map.of("error","invalid userId")); }
        } else {
            userUuid = UUID.fromString("0f08d2b9-28b3-4b28-bd33-41a36161e9ab");
        }
        long ttl = 3600;
        String token = issuerService.issue(userUuid, ttl);
        ResponseCookie cookie = ResponseCookie.from("sp_token", token)
                .httpOnly(true)
                .path("/")
                .sameSite("Lax")
                .maxAge(Duration.ofSeconds(ttl))
                .build();
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie.toString())
                .body(new LoginResponse(token, userUuid, ttl));
    }

    @GetMapping("/health")
    public ResponseEntity<?> health() {
        return ResponseEntity.ok(java.util.Map.of(
                "enabled", issuerService.isEnabled()
        ));
    }
}
