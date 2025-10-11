package com.safepocket.ledger.plaid;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PlaidWebhookController {
    private static final Logger log = LoggerFactory.getLogger(PlaidWebhookController.class);
    private final PlaidWebhookService service;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public PlaidWebhookController(PlaidWebhookService service) {
        this.service = service;
    }

    @PostMapping({"/webhook/plaid", "/plaid/webhook"})
    public ResponseEntity<String> handle(
            @RequestBody byte[] rawBody,
            @RequestHeader(name = "Plaid-Verification", required = false) String verificationHeader) {
        if (rawBody == null || rawBody.length == 0) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Empty body");
        }
        String bodyStr = new String(rawBody, StandardCharsets.UTF_8);
        // Verify JWT signature first; 401 if invalid (prod)
        boolean verified = service.verifySignature(bodyStr, verificationHeader, null);
        if (!verified) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("Invalid webhook signature");
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> payload = objectMapper.readValue(bodyStr, Map.class);
            service.process(payload, verificationHeader);
        } catch (Exception e) {
            log.warn("Failed to parse Plaid webhook payload: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Invalid JSON");
        }
        return ResponseEntity.ok("OK");
    }
}
