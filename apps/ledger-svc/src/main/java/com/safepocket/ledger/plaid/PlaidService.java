package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.entity.PlaidItemEntity;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.security.AccessTokenEncryptor;
import com.safepocket.ledger.security.RlsGuard;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class PlaidService {

    private final PlaidItemRepository plaidItemRepository;
    private final AccessTokenEncryptor accessTokenEncryptor;
    private final SafepocketProperties properties;
    private final JpaAccountRepository accountRepository;
    private final PlaidClient plaidClient;
    private final RlsGuard rlsGuard;

    public PlaidService(
            PlaidItemRepository plaidItemRepository,
            AccessTokenEncryptor accessTokenEncryptor,
            SafepocketProperties properties,
            JpaAccountRepository accountRepository,
            PlaidClient plaidClient,
            RlsGuard rlsGuard
    ) {
        this.plaidItemRepository = plaidItemRepository;
        this.accessTokenEncryptor = accessTokenEncryptor;
        this.properties = properties;
        this.accountRepository = accountRepository;
        this.plaidClient = plaidClient;
        this.rlsGuard = rlsGuard;
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
        // Ensure RLS context is set for this connection before DB writes
        rlsGuard.setAppsecUser(userId);

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

    /**
     * Fetch recent transactions from Plaid and map them into our domain model.
     * Returns empty list if no Plaid item or no accounts exist yet for the user.
     */
    public List<Transaction> fetchRecentTransactions(UUID userId, int days) {
        LocalDate endInclusive = LocalDate.now();
        LocalDate startInclusive = endInclusive.minusDays(Math.max(0, days - 1));
        return fetchTransactionsBetween(userId, startInclusive, endInclusive);
    }

    public List<Transaction> fetchTransactionsBetween(UUID userId, LocalDate startInclusive, LocalDate endInclusive) {
        rlsGuard.setAppsecUser(userId);
        var itemOpt = plaidItemRepository.findByUserId(userId);
        if (itemOpt.isEmpty()) return List.of();
        var item = itemOpt.get();
        String accessToken = decryptAccessToken(new PlaidItem(item.getUserId(), item.getItemId(), item.getEncryptedAccessToken(), item.getLinkedAt()));

        LocalDate start = startInclusive != null ? startInclusive : LocalDate.now().minusDays(30);
        LocalDate end = (endInclusive != null && !endInclusive.isBefore(start)) ? endInclusive : start;
        var resp = plaidClient.getTransactions(accessToken, start.toString(), end.toString(), 100);

        // Choose an account to attribute these transactions to (fallback: first account)
        var accounts = accountRepository.findByUserId(userId);
        if (accounts == null || accounts.isEmpty()) return List.of();
        UUID accountId = accounts.get(0).getId();

        List<Transaction> results = new ArrayList<>();
        for (var t : resp.transactions()) {
            String merchant = (t.merchantName() != null && !t.merchantName().isBlank()) ? t.merchantName() : t.name();
            var occurred = LocalDate.parse(t.date()).atStartOfDay(java.time.ZoneOffset.UTC).toInstant();
            var authorized = occurred.minus(1, ChronoUnit.HOURS);
            // Plaid amount is positive for outflows; store expenses as negative
            var amount = t.amount().negate();
            // Derive category: prefer Plaid personal finance primary, then joined category array, else fallback
            String category = "Uncategorized";
            if (t.personalFinanceCategory() != null && t.personalFinanceCategory().primary() != null && !t.personalFinanceCategory().primary().isBlank()) {
                category = t.personalFinanceCategory().primary();
            } else if (t.category() != null && !t.category().isEmpty()) {
                category = String.join("/", t.category());
            }
            results.add(new Transaction(
                    java.util.UUID.randomUUID(),
                    userId,
                    accountId,
                    merchant,
                    amount,
                    t.currency() != null ? t.currency() : "USD",
                    occurred,
                    authorized,
                    t.pending(),
                    category,
                    t.name(),
                    java.util.Optional.empty(),
                    java.util.Optional.empty()
            ));
        }
        return results;
    }

    public void unlink(UUID userId) {
        rlsGuard.setAppsecUser(userId);
        plaidItemRepository.deleteByUserId(userId);
    }
}
