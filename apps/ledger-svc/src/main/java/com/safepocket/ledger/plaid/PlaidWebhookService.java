package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Service;

@Service
public class PlaidWebhookService {
    private static final Logger log = LoggerFactory.getLogger(PlaidWebhookService.class);

    private final SafepocketProperties properties;
    private final Environment environment;

    public PlaidWebhookService(SafepocketProperties properties, Environment environment) {
        this.properties = properties;
        this.environment = environment;
    }

    /**
     * Verify Plaid webhook signature per https://plaid.com/docs/api/webhooks/webhook-verification/
     * Sandbox may send Plaid-Verification for testing. If PLAID_WEBHOOK_SECRET is unset:
     * - in prod: reject
     * - in non-prod: allow (logs a warning)
     */
    public boolean verifySignature(String rawBody, String signatureHeader, String verificationHeader) {
        String secret = properties.plaid().webhookSecret();
        // Allow bypass only outside prod when no secret configured
        if (secret == null || secret.isBlank()) {
            if (environment.acceptsProfiles(Profiles.of("prod"))) {
                log.warn("PLAID_WEBHOOK_SECRET not configured in prod; rejecting webhook");
                return false;
            }
            log.warn("PLAID_WEBHOOK_SECRET not set; accepting webhook without verification (non-prod)");
            return true;
        }
        try {
            // HMAC-SHA256 over raw body; compare Base64-encoded digest to Plaid-Signature if present
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(rawBody.getBytes(StandardCharsets.UTF_8));
            String computed = Base64.getEncoder().encodeToString(digest);
            if (signatureHeader != null && !signatureHeader.isBlank()) {
                String presented = signatureHeader.trim();
                // Support formats like "v1=base64signature[,t=timestamp]"
                String v1 = null;
                for (String part : presented.split(",")) {
                    String p = part.trim();
                    if (p.startsWith("v1=")) {
                        v1 = p.substring(3);
                        break;
                    }
                }
                if (v1 != null) {
                    presented = v1;
                }
                boolean ok = constantTimeEquals(computed, presented);
                if (!ok) log.warn("Plaid webhook signature mismatch");
                return ok;
            }
            if (verificationHeader != null && !verificationHeader.isBlank()) {
                boolean ok = constantTimeEquals(computed, verificationHeader.trim());
                if (!ok) log.warn("Plaid webhook verification header mismatch");
                return ok;
            }
            log.warn("Missing Plaid-Signature header");
            return false;
        } catch (Exception e) {
            log.warn("Failed to verify Plaid webhook: {}", e.getMessage());
            return false;
        }
    }

    private boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        if (a.length() != b.length()) return false;
        int res = 0;
        for (int i = 0; i < a.length(); i++) {
            res |= a.charAt(i) ^ b.charAt(i);
        }
        return res == 0;
    }

    public void process(Map<String, Object> body, String signature) {
        String webhookType = str(body.get("webhook_type"));
        String webhookCode = str(body.get("webhook_code"));
        String itemId = str(body.get("item_id"));
    // Signature is verified in controller via verifySignature()

        log.info("Plaid webhook received type={} code={} item={} at={} signaturePresent={}", webhookType, webhookCode, itemId, Instant.now(), signature != null);

        if ("TRANSACTIONS".equalsIgnoreCase(webhookType)) {
            handleTransactionsWebhook(webhookCode, body);
        } else {
            log.warn("Unhandled Plaid webhook type={} code={}", webhookType, webhookCode);
        }
    }

    private void handleTransactionsWebhook(String code, Map<String, Object> body) {
        switch (code) {
            case "INITIAL_UPDATE" -> log.info("Transactions INITIAL_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "HISTORICAL_UPDATE" -> log.info("Transactions HISTORICAL_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "DEFAULT_UPDATE" -> log.info("Transactions DEFAULT_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "TRANSACTIONS_REMOVED" -> log.info("Transactions REMOVED: removed_transactions={}", body.get("removed_transactions"));
            case "SYNC_UPDATES_AVAILABLE" -> log.info("Transactions SYNC_UPDATES_AVAILABLE" );
            default -> log.warn("Unknown transactions webhook code={}", code);
        }
        // TODO: enqueue background sync job / diff reconcile
    }

    private String str(Object o) { return o == null ? null : String.valueOf(o); }
}
