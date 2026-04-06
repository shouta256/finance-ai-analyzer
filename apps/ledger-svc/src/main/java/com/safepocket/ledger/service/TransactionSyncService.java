package com.safepocket.ledger.service;

import com.safepocket.ledger.demo.DemoDataFactory;
import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import com.safepocket.ledger.plaid.PlaidService;
import com.safepocket.ledger.user.UserService;
import com.safepocket.ledger.rag.TransactionEmbeddingService;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
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
    private final TransactionEmbeddingService transactionEmbeddingService;
    private final DemoDataFactory demoDataFactory;
    private final boolean demoSeedEnabled;
    private final Map<UUID, Instant> userSyncCursor = new ConcurrentHashMap<>();

    public TransactionSyncService(
            TransactionRepository transactionRepository,
            JpaAccountRepository jpaAccountRepository,
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            PlaidService plaidService,
            UserService userService,
            TransactionEmbeddingService transactionEmbeddingService,
            DemoDataFactory demoDataFactory,
            @org.springframework.beans.factory.annotation.Value("${safepocket.demo.seed:false}") boolean demoSeedEnabled
    ) {
        this.transactionRepository = transactionRepository;
        this.jpaAccountRepository = jpaAccountRepository;
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
        this.plaidService = plaidService;
        this.userService = userService;
        this.transactionEmbeddingService = transactionEmbeddingService;
        this.demoDataFactory = demoDataFactory;
        this.demoSeedEnabled = demoSeedEnabled;
    }

    public SyncResult triggerSync(boolean forceFullSync, boolean demoSeedRequested, Optional<LocalDate> startDate, String traceId) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        Instant lastSync = userSyncCursor.get(userId);
        boolean needsSeed = forceFullSync || lastSync == null || demoSeedRequested || startDate.isPresent();
        boolean useDemoSeed = demoSeedRequested || (demoSeedEnabled && startDate.isEmpty());
        int synced = 0;
        if (needsSeed) {
            List<Transaction> fetched = List.of();
            if (useDemoSeed) {
                fetched = seedTransactions(userId);
            } else {
                // Fetch real transactions from Plaid
                if (startDate.isPresent()) {
                    LocalDate start = startDate.get();
                    LocalDate end = LocalDate.now();
                    if (end.isBefore(start)) {
                        end = start;
                    }
                    fetched = plaidService.fetchTransactionsBetween(userId, start, end);
                } else {
                    fetched = plaidService.fetchRecentTransactions(userId, 30);
                }
            }
            List<Transaction> toInsert = dedupeTransactions(userId, fetched);
            if (!toInsert.isEmpty()) {
                toInsert.forEach(transactionRepository::save);
                synced = toInsert.size();
                List<UUID> txIds = toInsert.stream().map(Transaction::id).toList();
                transactionEmbeddingService.upsertEmbeddings(userId, txIds);
            }
        }
        transactionEmbeddingService.backfillMissingEmbeddings(userId);
        userSyncCursor.put(userId, Instant.now());
        // If demo seeding is disabled, there is no backlog to process.
        int pending = useDemoSeed ? Math.max(0, 50 - synced) : 0;
        return new SyncResult("STARTED", synced, pending, traceId);
    }

    private List<Transaction> dedupeTransactions(UUID userId, List<Transaction> candidates) {
        if (candidates.isEmpty()) {
            return List.of();
        }
        Set<String> existingFingerprints = loadExistingFingerprints(userId, candidates);
        List<Transaction> unique = new ArrayList<>(candidates.size());
        for (Transaction transaction : candidates) {
            String fingerprint = fingerprint(transaction);
            if (existingFingerprints.add(fingerprint)) {
                unique.add(transaction);
            }
        }
        return unique;
    }

    private Set<String> loadExistingFingerprints(UUID userId, List<Transaction> candidates) {
        Set<String> seen = new HashSet<>();
        if (candidates.isEmpty()) {
            return seen;
        }
        Set<YearMonth> months = candidates.stream()
                .map(tx -> YearMonth.from(tx.occurredAt().atZone(ZoneOffset.UTC)))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        for (YearMonth month : months) {
            transactionRepository.findByUserIdAndMonth(userId, month).stream()
                    .map(this::fingerprint)
                    .forEach(seen::add);
        }
        return seen;
    }

    private String fingerprint(Transaction transaction) {
        String merchant = transaction.merchantName() == null ? "" : transaction.merchantName().trim().toLowerCase();
        String amount = transaction.amount() == null
                ? "0.00"
                : transaction.amount().setScale(2, RoundingMode.HALF_EVEN).toPlainString();
        String occurred = transaction.occurredAt() == null
                ? ""
                : transaction.occurredAt().truncatedTo(ChronoUnit.MINUTES).toString();
        String pending = transaction.pending() ? "1" : "0";
        return transaction.accountId() + "|" + merchant + "|" + amount + "|" + occurred + "|" + pending;
    }

    public void clearUserSyncState(UUID userId) {
        userSyncCursor.remove(userId);
    }

    private List<Transaction> seedTransactions(UUID userId) {
        resetDemoData(userId);
        userService.ensureUserExists(userId, null, null);
        List<AccountEntity> accounts = demoDataFactory.buildAccounts(userId);
        if (!accounts.isEmpty()) {
            jpaAccountRepository.saveAll(accounts);
        }
        return demoDataFactory.buildTransactions(userId, demoDataFactory.buildAccountIdIndex(userId));
    }

    private void resetDemoData(UUID userId) {
        transactionEmbeddingService.deleteAll(userId);
        transactionRepository.deleteByUserId(userId);
        jpaAccountRepository.deleteByUserId(userId);
    }
}
