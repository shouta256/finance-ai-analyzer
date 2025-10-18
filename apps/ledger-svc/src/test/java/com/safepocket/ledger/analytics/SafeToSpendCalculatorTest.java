package com.safepocket.ledger.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.AccountBalanceProjection;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class SafeToSpendCalculatorTest {

    @Mock
    private TransactionRepository transactionRepository;

    @Mock
    private JpaAccountRepository accountRepository;

    private SafeToSpendCalculator calculator;

    private final UUID userId = UUID.randomUUID();

    private LocalDate today;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        calculator = new SafeToSpendCalculator(transactionRepository, accountRepository);
        today = LocalDate.now(ZoneOffset.UTC);
    }

    @Test
    void calculatesSafeToSpendWithCycleAndBudgets() {
        LocalDate currentIncomeDate = today.minusDays(2);
        LocalDate previousIncomeDate = today.minusDays(16);

        List<Transaction> history = List.of(
                // incomes define cycle
                transaction("Employer Payroll", BigDecimal.valueOf(2200), currentIncomeDate, "Income"),
                transaction("Employer Payroll", BigDecimal.valueOf(2200), previousIncomeDate, "Income"),
                // fixed merchant history (no payment yet this cycle)
                transaction("Local Rent Co", BigDecimal.valueOf(-900), previousIncomeDate.minusDays(2), "Housing"),
                transaction("Local Rent Co", BigDecimal.valueOf(-900), previousIncomeDate.minusDays(32), "Housing"),
                // sinking fund history (not paid yet)
                transaction("Vacation Fund", BigDecimal.valueOf(-120), previousIncomeDate.minusDays(10), "Sinking"),
                transaction("Vacation Fund", BigDecimal.valueOf(-120), previousIncomeDate.minusDays(40), "Sinking"),
                // previous cycle variable spend
                transaction("Trader Joes", BigDecimal.valueOf(-150), previousIncomeDate.plusDays(3), "Groceries")
        );

        when(transactionRepository.findByUserIdAndRange(any(), any(), any())).thenReturn(history);
        when(accountRepository.findSummariesByUserId(userId)).thenReturn(
                List.of(new AccountBalanceProjection(
                        UUID.randomUUID(),
                        userId,
                        "Checking",
                        "Demo Bank",
                        Instant.now(),
                        BigDecimal.valueOf(1800),
                        Instant.now()
                ))
        );

        AnalyticsSummary.SafeToSpend safeToSpend = calculator.calculate(
                userId,
                YearMonth.from(today),
                List.of()
        );

        assertThat(safeToSpend).isNotNull();
        assertThat(safeToSpend.cycleStart()).isEqualTo(currentIncomeDate);
        assertThat(safeToSpend.variableBudget()).isEqualByComparingTo(BigDecimal.valueOf(150.00).setScale(2));
        assertThat(safeToSpend.variableSpent()).isZero();
        assertThat(safeToSpend.safeToSpendToday()).isPositive();
        assertThat(safeToSpend.hardCap()).isGreaterThan(BigDecimal.ZERO);
        assertThat(safeToSpend.safeToSpendToday()).isLessThanOrEqualTo(safeToSpend.hardCap().abs());
        assertThat(safeToSpend.danger()).isFalse();
    }

    private Transaction transaction(String merchant, BigDecimal amount, LocalDate date, String category) {
        return new Transaction(
                UUID.randomUUID(),
                userId,
                UUID.randomUUID(),
                merchant,
                amount,
                "USD",
                date.atStartOfDay().toInstant(ZoneOffset.UTC),
                date.atStartOfDay().minusHours(1).toInstant(ZoneOffset.UTC),
                false,
                category,
                merchant,
                Optional.empty(),
                Optional.empty()
        );
    }
}
