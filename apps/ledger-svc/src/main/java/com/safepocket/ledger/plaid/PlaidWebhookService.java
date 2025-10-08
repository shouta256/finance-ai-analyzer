package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import java.time.Instant;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class PlaidWebhookService {
    private static final Logger log = LoggerFactory.getLogger(PlaidWebhookService.class);

    private final SafepocketProperties properties;

    public PlaidWebhookService(SafepocketProperties properties) {
        this.properties = properties;
    }

    public void process(Map<String, Object> body, String signature) {
        String webhookType = str(body.get("webhook_type"));
        String webhookCode = str(body.get("webhook_code"));
        String itemId = str(body.get("item_id"));
        // NOTE: future: verify signature with properties.plaid().webhookSecret()

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
