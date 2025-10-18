package com.safepocket.ledger.plaid;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.entity.PlaidItemEntity;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.security.AccessTokenEncryptor;
import com.safepocket.ledger.security.RlsGuard;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class PlaidServiceTest {

    @Mock
    private PlaidItemRepository plaidItemRepository;

    @Mock
    private AccessTokenEncryptor accessTokenEncryptor;

    @Mock
    private SafepocketProperties properties;

    @Mock
    private JpaAccountRepository accountRepository;

    @Mock
    private PlaidClient plaidClient;

    @Mock
    private RlsGuard rlsGuard;

    private PlaidService plaidService;

    private final UUID userId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        plaidService = new PlaidService(
                plaidItemRepository,
                accessTokenEncryptor,
                properties,
                accountRepository,
                plaidClient,
                rlsGuard
        );
    }

    @Test
    void normalisesAmountsToExpenseAndIncomeConventions() {
        var item = new PlaidItemEntity(userId, "item-1", "cipher", Instant.now());
        when(plaidItemRepository.findByUserId(userId)).thenReturn(Optional.of(item));
        when(accessTokenEncryptor.decrypt("cipher")).thenReturn("access-token");
        var accountId = UUID.randomUUID();
        when(accountRepository.findByUserId(userId)).thenReturn(
                List.of(new AccountEntity(accountId, userId, "Primary Checking", "Plaid", Instant.now()))
        );

        var expenseTransaction = new PlaidClient.TransactionsGetResponse.PlaidTransaction(
                "Coffee Shop",
                "Coffee Shop",
                new BigDecimal("18.42"),
                "USD",
                LocalDate.now().toString(),
                false,
                List.of("Food", "Coffee"),
                new PlaidClient.TransactionsGetResponse.PlaidTransaction.PersonalFinanceCategory("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE")
        );
        var incomeTransaction = new PlaidClient.TransactionsGetResponse.PlaidTransaction(
                "Employer Payroll",
                "Employer Payroll",
                new BigDecimal("-2500.00"),
                "USD",
                LocalDate.now().toString(),
                false,
                List.of("Income", "Payroll"),
                new PlaidClient.TransactionsGetResponse.PlaidTransaction.PersonalFinanceCategory("INCOME_WAGES", "INCOME_WAGES_AND_SALARIES")
        );

        when(plaidClient.getTransactions(anyString(), anyString(), anyString(), anyInt()))
                .thenReturn(new PlaidClient.TransactionsGetResponse(List.of(expenseTransaction, incomeTransaction), "req-1"));

        List<Transaction> results = plaidService.fetchTransactionsBetween(userId, LocalDate.now().minusDays(7), LocalDate.now());

        assertThat(results).hasSize(2);
        Transaction expense = results.stream().filter(tx -> tx.merchantName().equals("Coffee Shop")).findFirst().orElseThrow();
        Transaction income = results.stream().filter(tx -> tx.merchantName().equals("Employer Payroll")).findFirst().orElseThrow();

        assertThat(expense.amount()).isEqualByComparingTo(new BigDecimal("-18.42"));
        assertThat(income.amount()).isEqualByComparingTo(new BigDecimal("2500.00"));
    }
}
