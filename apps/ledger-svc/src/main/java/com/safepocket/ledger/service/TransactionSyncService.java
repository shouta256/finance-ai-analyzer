package com.safepocket.ledger.service;

import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import com.safepocket.ledger.plaid.PlaidService;
import com.safepocket.ledger.user.UserService;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

@Service
public class TransactionSyncService {

    public record SyncResult(String status, int syncedCount, int pendingCount, String traceId) {
    }

    private final TransactionRepository transactionRepository;
    private final JpaAccountRepository jpaAccountRepository;
    private final AuthenticatedUserProvider authenticatedUserProvider;
    private final RlsGuard rlsGuard;
    private final PlaidService plaidService;
    private final UserService userService;
    private final boolean demoSeedEnabled;
    private final Map<UUID, Instant> userSyncCursor = new ConcurrentHashMap<>();

    public TransactionSyncService(
            TransactionRepository transactionRepository,
            JpaAccountRepository jpaAccountRepository,
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            PlaidService plaidService,
            UserService userService,
            @org.springframework.beans.factory.annotation.Value("${safepocket.demo.seed:false}") boolean demoSeedEnabled
    ) {
        this.transactionRepository = transactionRepository;
        this.jpaAccountRepository = jpaAccountRepository;
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
        this.plaidService = plaidService;
        this.userService = userService;
        this.demoSeedEnabled = demoSeedEnabled;
    }

    public SyncResult triggerSync(boolean forceFullSync, boolean demoSeedRequested, String traceId) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        Instant lastSync = userSyncCursor.get(userId);
        boolean needsSeed = forceFullSync || lastSync == null || demoSeedRequested;
        boolean useDemoSeed = demoSeedRequested || demoSeedEnabled;
        int synced = 0;
        if (needsSeed) {
            List<Transaction> toInsert = List.of();
            if (useDemoSeed) {
                ensureDemoAccounts(userId);
                toInsert = seedTransactions(userId);
            } else {
                // Fetch recent real transactions from Plaid
                toInsert = plaidService.fetchRecentTransactions(userId, 30);
            }
            if (!toInsert.isEmpty()) {
                toInsert.forEach(transactionRepository::save);
                synced = toInsert.size();
                // Embedding updates removed as RAG is deprecated
            }
        }
        userSyncCursor.put(userId, Instant.now());
        // If demo seeding is disabled, there is no backlog to process.
        int pending = useDemoSeed ? Math.max(0, 50 - synced) : 0;
        return new SyncResult("STARTED", synced, pending, traceId);
    }

    private void ensureDemoAccounts(UUID userId) {
        List<AccountEntity> existing = jpaAccountRepository.findByUserId(userId);
        userService.ensureUserExists(userId, null, null);
        Instant now = Instant.now();
        boolean hasChecking = existing.stream().anyMatch(acc -> acc.getName().equalsIgnoreCase("Demo Checking Account"));
        boolean hasSavings = existing.stream().anyMatch(acc -> acc.getName().equalsIgnoreCase("Demo Savings Account"));
        boolean hasCredit = existing.stream().anyMatch(acc -> acc.getName().equalsIgnoreCase("Demo Credit Card"));

        List<AccountEntity> toCreate = new ArrayList<>();
        if (!hasChecking) {
            toCreate.add(new AccountEntity(UUID.randomUUID(), userId, "Demo Checking Account", "Safepocket Demo Bank", now));
        }
        if (!hasSavings) {
            toCreate.add(new AccountEntity(UUID.randomUUID(), userId, "Demo Savings Account", "Safepocket Demo Bank", now));
        }
        if (!hasCredit) {
            toCreate.add(new AccountEntity(UUID.randomUUID(), userId, "Demo Credit Card", "Safepocket Demo Bank", now));
        }
        if (!toCreate.isEmpty()) {
            jpaAccountRepository.saveAll(toCreate);
        }
    }

    private List<Transaction> seedTransactions(UUID userId) {
        List<Transaction> transactions = new ArrayList<>();

        List<AccountEntity> userAccounts = jpaAccountRepository.findByUserId(userId);
        if (userAccounts.isEmpty()) {
            return transactions;
        }

        UUID checkingAccount = null;
        UUID savingsAccount = null;
        UUID creditAccount = null;

        for (AccountEntity account : userAccounts) {
            String accountName = account.getName().toLowerCase();
            if (accountName.contains("checking") || accountName.contains("primary")) {
                checkingAccount = account.getId();
            } else if (accountName.contains("savings")) {
                savingsAccount = account.getId();
            } else if (accountName.contains("credit")) {
                creditAccount = account.getId();
            }
        }
        
        // If we don't have specific account types, use the first available accounts
        if (checkingAccount == null && !userAccounts.isEmpty()) {
            checkingAccount = userAccounts.get(0).getId();
        }
        if (savingsAccount == null && userAccounts.size() > 1) {
            savingsAccount = userAccounts.get(1).getId();
        }
        if (creditAccount == null && userAccounts.size() > 2) {
            creditAccount = userAccounts.get(2).getId();
        }
        
        YearMonth currentMonth = YearMonth.now(ZoneOffset.UTC);
        YearMonth previousMonth = currentMonth.minusMonths(1);

        // Helper to create a timestamp at start of given day within month in UTC (clamped to month length)
        java.util.function.BiFunction<YearMonth, Integer, Instant> dayOf = (month, day) -> {
            int d = Math.max(1, Math.min(day, month.lengthOfMonth()));
            return month.atDay(d).atStartOfDay(ZoneOffset.UTC).toInstant();
        };

        // Create transactions only for accounts that exist
        if (checkingAccount != null) {
            // Current month
            transactions.add(createTransaction(userId, checkingAccount, "Stripe Payroll", BigDecimal.valueOf(4200.00), "Income", dayOf.apply(currentMonth, 5), "Bi-weekly payroll deposit", false));
            transactions.add(createTransaction(userId, checkingAccount, "Amazon", BigDecimal.valueOf(-220.45), "Shopping", dayOf.apply(currentMonth, 2), "Household items", false));
            transactions.add(createTransaction(userId, checkingAccount, "Trader Joes", BigDecimal.valueOf(-94.36), "Groceries", dayOf.apply(currentMonth, 8), "Weekly grocery run", false));
            transactions.add(createTransaction(userId, checkingAccount, "Whole Foods Market", BigDecimal.valueOf(-168.20), "Groceries", dayOf.apply(currentMonth, 12), "Organic groceries", false));
            transactions.add(createTransaction(userId, checkingAccount, "Blue Bottle Coffee", BigDecimal.valueOf(-12.50), "Dining", dayOf.apply(currentMonth, 7), "Morning latte", false));
            transactions.add(createTransaction(userId, checkingAccount, "Local Rent Co", BigDecimal.valueOf(-1850.00), "Housing", dayOf.apply(currentMonth, 3), "Monthly rent", false));
            transactions.add(createTransaction(userId, checkingAccount, "Utility Power Co", BigDecimal.valueOf(-130.45), "Utilities", dayOf.apply(currentMonth, 10), "Electric bill", false));
            transactions.add(createTransaction(userId, checkingAccount, "Uber Technologies", BigDecimal.valueOf(-42.10), "Transport", dayOf.apply(currentMonth, 4), "Airport ride", false));
            transactions.add(createTransaction(userId, checkingAccount, "Lyft", BigDecimal.valueOf(-18.30), "Transport", dayOf.apply(currentMonth, 12), "Downtown ride", false));
            transactions.add(createTransaction(userId, checkingAccount, "Airbnb", BigDecimal.valueOf(-610.75), "Travel", dayOf.apply(currentMonth, 20), "Weekend getaway", false));
            transactions.add(createTransaction(userId, checkingAccount, "Delta Airlines", BigDecimal.valueOf(-425.10), "Travel", dayOf.apply(currentMonth, 22), "Flight to NYC", false));

        // INTENTIONAL OUTLIERS to trigger anomaly detection (Z-SCORE / IQR)
        // These high-magnitude debits are significantly larger than typical spends this month
        transactions.add(createTransaction(
            userId,
            checkingAccount,
            "Designer Furniture Warehouse",
            BigDecimal.valueOf(-4999.00),
            "Shopping",
            dayOf.apply(currentMonth, 15),
            "Intentional outlier: large one-time purchase to trigger anomaly",
            false
        ));
        transactions.add(createTransaction(
            userId,
            checkingAccount,
            "Emergency Hospital Bill",
            BigDecimal.valueOf(-3200.00),
            "Healthcare",
            dayOf.apply(currentMonth, 18),
            "Intentional outlier: unusually large expense",
            false
        ));

            // Previous month (a couple for continuity)
            transactions.add(createTransaction(userId, checkingAccount, "Stripe Payroll", BigDecimal.valueOf(4200.00), "Income", dayOf.apply(previousMonth, 5), "Bi-weekly payroll deposit", false));
            transactions.add(createTransaction(userId, checkingAccount, "Trader Joes", BigDecimal.valueOf(-84.10), "Groceries", dayOf.apply(previousMonth, 16), "Weekly grocery run", false));
        }

        if (savingsAccount != null) {
            transactions.add(createTransaction(userId, savingsAccount, "Auto Transfer", BigDecimal.valueOf(-500.00), "Transfer", dayOf.apply(currentMonth, 6), "Transfer to savings", false));
            transactions.add(createTransaction(userId, savingsAccount, "Savings Interest", BigDecimal.valueOf(6.25), "Income", dayOf.apply(currentMonth, Math.max(25, currentMonth.lengthOfMonth()-2)), "Monthly interest", false));
        }

        if (creditAccount != null) {
            transactions.add(createTransaction(userId, creditAccount, "Netflix", BigDecimal.valueOf(-15.99), "Entertainment", dayOf.apply(currentMonth, 2), "Streaming subscription", false));
            transactions.add(createTransaction(userId, creditAccount, "Spotify", BigDecimal.valueOf(-9.99), "Entertainment", dayOf.apply(currentMonth, 11), "Music subscription", false));
            transactions.add(createTransaction(userId, creditAccount, "Apple", BigDecimal.valueOf(-89.99), "Shopping", dayOf.apply(currentMonth, 14), "Accessories purchase", false));
            transactions.add(createTransaction(userId, creditAccount, "Starbucks", BigDecimal.valueOf(-8.75), "Dining", dayOf.apply(currentMonth, 1), "Coffee with client", true));
        }

        return transactions;
    }

    private Transaction createTransaction(
            UUID userId,
            UUID accountId,
            String merchant,
            BigDecimal amount,
            String category,
            Instant occurredAt,
            String description,
            boolean pending
    ) {
        return new Transaction(
                UUID.randomUUID(),
                userId,
                accountId,
                merchant,
                amount,
                "USD",
                occurredAt,
                occurredAt.minus(1, ChronoUnit.HOURS),
                pending,
                category,
                description,
                java.util.Optional.empty(),
                java.util.Optional.empty()
        );
    }
}
