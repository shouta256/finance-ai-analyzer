package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.security.AccessTokenEncryptor;
import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.entity.PlaidItemEntity;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class PlaidService {

    private final PlaidItemRepository plaidItemRepository;
    private final AccessTokenEncryptor accessTokenEncryptor;
    private final SafepocketProperties properties;
    private final JpaAccountRepository accountRepository;

    private final PlaidClient plaidClient;

    public PlaidService(
            PlaidItemRepository plaidItemRepository,
            AccessTokenEncryptor accessTokenEncryptor,
            SafepocketProperties properties,
            JpaAccountRepository accountRepository,
            PlaidClient plaidClient
    ) {
        this.plaidItemRepository = plaidItemRepository;
        this.accessTokenEncryptor = accessTokenEncryptor;
        this.properties = properties;
        this.accountRepository = accountRepository;
        this.plaidClient = plaidClient;
    }

    public PlaidLinkToken createLinkToken(UUID userId) {
        var response = plaidClient.createLinkToken(userId.toString());
        // Plaid returns expiration as RFC 3339 timestamp; we let frontend treat it as string but here parse to Instant if needed.
        Instant exp;
        try {
            exp = Instant.parse(response.expiration());
        } catch (Exception e) {
            exp = Instant.now().plus(30, ChronoUnit.MINUTES); // fallback
        }
        return new PlaidLinkToken(response.linkToken(), exp, response.requestId());
    }

    public PlaidItem exchangePublicToken(UUID userId, String publicToken) {
        var response = plaidClient.exchangePublicToken(publicToken);
        String encrypted = accessTokenEncryptor.encrypt(response.accessToken());
        PlaidItemEntity entity = plaidItemRepository.findByUserId(userId)
                .map(existing -> {
                    existing.setItemId(response.itemId());
                    existing.setEncryptedAccessToken(encrypted);
                    existing.setLinkedAt(Instant.now());
                    return existing;
                })
                .orElseGet(() -> new PlaidItemEntity(userId, response.itemId(), encrypted, Instant.now()));
        plaidItemRepository.save(entity);
        // Auto-provision default accounts if none exist yet for this user
        try {
            var accounts = accountRepository.findByUserId(userId);
            if (accounts == null || accounts.isEmpty()) {
                var now = Instant.now();
                var defaults = java.util.List.of(
                        new AccountEntity(java.util.UUID.randomUUID(), userId, "Primary Checking", "Plaid Sandbox", now),
                        new AccountEntity(java.util.UUID.randomUUID(), userId, "Savings", "Plaid Sandbox", now),
                        new AccountEntity(java.util.UUID.randomUUID(), userId, "Credit Card", "Plaid Sandbox", now)
                );
                accountRepository.saveAll(defaults);
            }
        } catch (Exception e) {
            // Non-fatal: syncing can still proceed for existing accounts
        }
        return new PlaidItem(entity.getUserId(), entity.getItemId(), entity.getEncryptedAccessToken(), entity.getLinkedAt());
    }

    public String decryptAccessToken(PlaidItem item) { return accessTokenEncryptor.decrypt(item.encryptedAccessToken()); }

    public SafepocketProperties.Plaid plaidProperties() {
        return properties.plaid();
    }
}
