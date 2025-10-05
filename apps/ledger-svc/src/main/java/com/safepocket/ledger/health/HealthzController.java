package com.safepocket.ledger.health;

import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Lightweight unauthenticated health endpoint intended for external/public checks.
 * Distinct from Actuator which remains internal-focused.
 */
@RestController
public class HealthzController {

    @GetMapping(path = "/healthz", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> healthz() {
        return Map.of("status", "UP");
    }
}
