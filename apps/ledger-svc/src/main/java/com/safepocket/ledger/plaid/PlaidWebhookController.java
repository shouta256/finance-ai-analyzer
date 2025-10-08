package com.safepocket.ledger.plaid;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/plaid")
public class PlaidWebhookController {
    private static final Logger log = LoggerFactory.getLogger(PlaidWebhookController.class);
    private final PlaidWebhookService service;

    public PlaidWebhookController(PlaidWebhookService service) {
        this.service = service;
    }

    @PostMapping("/webhook")
    public ResponseEntity<Void> handle(
            @RequestBody Map<String, Object> payload,
            @RequestHeader(name = "Plaid-Signature", required = false) String signature) {
        service.process(payload, signature);
        return ResponseEntity.ok().build();
    }
}
