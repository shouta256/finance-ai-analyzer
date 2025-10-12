package com.safepocket.ledger.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.repository.InMemoryTransactionRepository;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import com.safepocket.ledger.rag.TransactionEmbeddingService;
import com.safepocket.ledger.plaid.PlaidService;
import com.safepocket.ledger.user.UserService;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class TransactionSyncServiceTest {

    @Mock
    private AuthenticatedUserProvider authenticatedUserProvider;

    @Mock
    private RlsGuard rlsGuard;

    @Mock
    private JpaAccountRepository jpaAccountRepository;

    @Mock
    private TransactionEmbeddingService transactionEmbeddingService;

    @Mock
    private PlaidService plaidService;

    @Mock
    private UserService userService;

    private TransactionRepository transactionRepository;

    private TransactionSyncService transactionSyncService;

    private final UUID userId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        transactionRepository = new InMemoryTransactionRepository();
    // Prepare mock accounts for the user so syncing uses real account IDs
    List<AccountEntity> accounts = List.of(
        new AccountEntity(UUID.randomUUID(), userId, "Primary Checking", "Plaid Sandbox", Instant.now()),
        new AccountEntity(UUID.randomUUID(), userId, "High-Yield Savings", "Plaid Sandbox", Instant.now()),
        new AccountEntity(UUID.randomUUID(), userId, "Rewards Credit Card", "Plaid Sandbox", Instant.now())
    );
    when(jpaAccountRepository.findByUserId(userId)).thenReturn(accounts);

        transactionSyncService = new TransactionSyncService(
            transactionRepository,
            jpaAccountRepository,
            authenticatedUserProvider,
            rlsGuard,
            transactionEmbeddingService,
            plaidService,
            userService,
            true
        );
    }

    @Test
    void seedsTransactionsOnFirstSync() {
        when(authenticatedUserProvider.requireCurrentUserId()).thenReturn(userId);
        var result = transactionSyncService.triggerSync(false, false, "trace-1");

        assertThat(result.syncedCount()).isGreaterThan(0);
        YearMonth current = YearMonth.now(ZoneOffset.UTC);
        var currentMonthTransactions = transactionRepository.findByUserIdAndMonth(userId, current);
        if (!currentMonthTransactions.isEmpty()) {
            assertThat(currentMonthTransactions).isNotEmpty();
            return;
        }
        YearMonth previous = current.minusMonths(1);
        assertThat(transactionRepository.findByUserIdAndMonth(userId, previous)).isNotEmpty();
    }

    @Test
    void doesNotSeedWhenDisabled() {
        // Reinitialize service with seeding disabled
        transactionSyncService = new TransactionSyncService(
            transactionRepository,
            jpaAccountRepository,
            authenticatedUserProvider,
            rlsGuard,
            transactionEmbeddingService,
            plaidService,
            userService,
            false
        );

        when(authenticatedUserProvider.requireCurrentUserId()).thenReturn(userId);
        var result = transactionSyncService.triggerSync(false, false, "trace-2");
        assertThat(result.syncedCount()).isZero();
        assertThat(result.pendingCount()).isZero();
        YearMonth current = YearMonth.now(ZoneOffset.UTC);
        assertThat(transactionRepository.findByUserIdAndMonth(userId, current)).isEmpty();
    }

    @Test
    void seedsWhenRequestedEvenIfDisabled() {
        transactionSyncService = new TransactionSyncService(
            transactionRepository,
            jpaAccountRepository,
            authenticatedUserProvider,
            rlsGuard,
            transactionEmbeddingService,
            plaidService,
            userService,
            false
        );

        when(authenticatedUserProvider.requireCurrentUserId()).thenReturn(userId);
        var result = transactionSyncService.triggerSync(false, true, "trace-3");

        assertThat(result.syncedCount()).isGreaterThan(0);
        YearMonth current = YearMonth.now(ZoneOffset.UTC);
        var seeded = transactionRepository.findByUserIdAndMonth(userId, current);
        if (!seeded.isEmpty()) {
            assertThat(seeded).isNotEmpty();
        } else {
            YearMonth previous = current.minusMonths(1);
            assertThat(transactionRepository.findByUserIdAndMonth(userId, previous)).isNotEmpty();
        }
    }
}
