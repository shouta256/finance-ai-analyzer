package com.safepocket.ledger.security;

import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.config.SecurityConfig;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

public class JwtIssuerServiceTest {

    private JwtIssuerService newService(String secret) {
        SafepocketProperties props = new SafepocketProperties(
                new SafepocketProperties.Cognito("https://example.com/issuer","aud", false),
                new SafepocketProperties.Plaid("id","sec","redir","base","env",null,null),
                new SafepocketProperties.Ai("model","https://api.example.com",null,null),
                new SafepocketProperties.Security(secret)
        );
        return new JwtIssuerService(props);
    }

    @Test
    void issueToken_ok() {
        JwtIssuerService svc = newService("12345678901234567890123456789012");
        assertTrue(svc.isEnabled());
        String jwt = svc.issue(UUID.randomUUID(), 60);
        assertNotNull(jwt);
        assertTrue(jwt.split("\\.").length == 3, "should be a JWT");
    }

    @Test
    void tooShortSecret_rejected() {
        IllegalStateException ex = assertThrows(IllegalStateException.class, () -> newService("shortsecret"));
        assertTrue(ex.getMessage().contains("32"));
    }

    @Test
    void decoderAcceptsDevToken() {
        SafepocketProperties props = new SafepocketProperties(
                new SafepocketProperties.Cognito("https://example.com/issuer","aud", false),
                new SafepocketProperties.Plaid("id","sec","redir","base","env",null,null),
                new SafepocketProperties.Ai("model","https://api.example.com",null,null),
                new SafepocketProperties.Security("12345678901234567890123456789012")
        );
        JwtIssuerService issuer = new JwtIssuerService(props);
        String token = issuer.issue(UUID.fromString("0f08d2b9-28b3-4b28-bd33-41a36161e9ab"), 60);

        SecurityConfig config = new SecurityConfig();
        MockEnvironment env = new MockEnvironment();
        assertDoesNotThrow(() -> config.jwtDecoder(props, env).decode(token));
    }
}
