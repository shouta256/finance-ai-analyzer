package com.safepocket.ledger.analytics;

import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.AccountBalanceProjection;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
public class SafeToSpendCalculator {

    private static final BigDecimal ZERO = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
    private static final BigDecimal DEFAULT_BUFFER = new BigDecimal("100.00");
    private static final BigDecimal HALF = new BigDecimal("0.5");
    private static final BigDecimal MIN_ADJUST = new BigDecimal("0.85");
    private static final BigDecimal MAX_ADJUST = new BigDecimal("1.15");
    private static final BigDecimal ROLL_CAP_MULTIPLIER = new BigDecimal("1.5");
    private static final double ADJUSTMENT_COEFFICIENT = 0.5;
    private static final int HISTORY_WINDOW_DAYS = 120;
    private static final Set<String> FIXED_CATEGORY_KEYWORDS = Set.of(
            "housing", "rent", "mortgage", "utilities", "internet", "phone",
            "insurance", "loan", "debt", "subscription", "subscriptions"
    );
    private static final Set<String> SINKING_CATEGORY_KEYWORDS = Set.of(
            "savings", "sinking", "emergency", "vacation", "education", "investment", "investments"
    );

    private final TransactionRepository transactionRepository;
    private final JpaAccountRepository accountRepository;

    public SafeToSpendCalculator(TransactionRepository transactionRepository, JpaAccountRepository accountRepository) {
        this.transactionRepository = transactionRepository;
        this.accountRepository = accountRepository;
    }

    public AnalyticsSummary.SafeToSpend calculate(UUID userId, YearMonth focusMonth, List<Transaction> monthTransactions) {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        Instant historyStart = today.minusDays(HISTORY_WINDOW_DAYS).atStartOfDay(ZoneOffset.UTC).toInstant();
        Instant historyEnd = today.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        List<Transaction> history = transactionRepository.findByUserIdAndRange(userId, historyStart, historyEnd);
        if (monthTransactions != null && !monthTransactions.isEmpty()) {
            // ensure month transactions are included when outside the history window (e.g., future-dated fixtures)
            Map<UUID, Transaction> existing = history.stream().collect(Collectors.toMap(Transaction::id, tx -> tx, (a, b) -> a));
            for (Transaction tx : monthTransactions) {
                existing.putIfAbsent(tx.id(), tx);
            }
            history = new ArrayList<>(existing.values());
        }

        BigDecimal cashOnHand = accountRepository.findSummariesByUserId(userId).stream()
                .map(AccountBalanceProjection::balance)
                .filter(amount -> amount != null)
                .map(amount -> amount.setScale(2, RoundingMode.HALF_UP))
                .reduce(ZERO, BigDecimal::add);

        CycleWindow window = determineCycleWindow(history, focusMonth, today);
        List<Transaction> cycleTransactions = filterByDate(history, window.cycleStart(), window.cycleEnd());
        List<Transaction> previousCycleTransactions = filterByDate(history, window.previousCycleStart(), window.cycleStart().minusDays(1));

        BigDecimal variableBudget = deriveVariableBudget(previousCycleTransactions, window);
        if (variableBudget.compareTo(BigDecimal.ZERO) <= 0) {
            BigDecimal fallback = deriveVariableBudget(cycleTransactions, window);
            variableBudget = fallback.compareTo(BigDecimal.ZERO) > 0 ? fallback : BigDecimal.valueOf(500.00);
        }

        Map<LocalDate, BigDecimal> variableSpendByDay = mapVariableSpendByDay(cycleTransactions, window);
        BigDecimal variableSpentBeforeToday = sumVariableSpend(variableSpendByDay, window.cycleStart(), today.minusDays(1));
        BigDecimal variableSpentIncludingToday = sumVariableSpend(variableSpendByDay, window.cycleStart(), today);
        BigDecimal remainingVariableBudget = variableBudget.subtract(variableSpentIncludingToday).max(BigDecimal.ZERO);

        int daysRemaining = Math.max(1, (int) ChronoUnit.DAYS.between(today, window.cycleEnd()) + 1);
        BigDecimal dailyBase = variableBudget.subtract(variableSpentBeforeToday);
        if (dailyBase.signum() < 0) {
            dailyBase = BigDecimal.ZERO;
        }
        dailyBase = divideSafe(dailyBase, BigDecimal.valueOf(daysRemaining));

        int elapsedDays = Math.max(1, (int) ChronoUnit.DAYS.between(window.cycleStart(), today));
        int totalDays = Math.max(1, (int) ChronoUnit.DAYS.between(window.cycleStart(), window.cycleEnd()) + 1);
        BigDecimal paceRatio = computePaceRatio(variableBudget, variableSpentBeforeToday, elapsedDays, totalDays);
        BigDecimal adjustmentFactor = applyAdjustment(paceRatio);
        BigDecimal dailyAdjusted = dailyBase.multiply(adjustmentFactor).setScale(2, RoundingMode.HALF_UP);

        BigDecimal rollToday = simulateRoll(variableBudget, variableSpendByDay, window, today);

        BigDecimal sinkingRemaining = estimateRemaining(history, window, today, SafeToSpendCalculator::isSinkingCategory);
        BigDecimal fixedRemaining = estimateRemaining(history, window, today, SafeToSpendCalculator::isFixedCategory);
        BigDecimal futureIncome = sumFutureIncome(cycleTransactions, today, window.cycleEnd());
        BigDecimal hardCap = cashOnHand
                .add(futureIncome)
                .subtract(fixedRemaining)
                .subtract(sinkingRemaining)
                .subtract(DEFAULT_BUFFER)
                .setScale(2, RoundingMode.HALF_UP);

        BigDecimal safeToSpend = dailyAdjusted.add(rollToday);
        if (hardCap.signum() >= 0) {
            safeToSpend = safeToSpend.min(hardCap);
        }
        if (safeToSpend.signum() < 0) {
            safeToSpend = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        } else {
            safeToSpend = safeToSpend.setScale(2, RoundingMode.HALF_UP);
        }

        boolean danger = hardCap.signum() <= 0;
        List<String> notes = buildNotes(danger, paceRatio, remainingVariableBudget);

        return new AnalyticsSummary.SafeToSpend(
                window.cycleStart(),
                window.cycleEnd(),
                safeToSpend,
                hardCap,
                dailyBase.setScale(2, RoundingMode.HALF_UP),
                dailyAdjusted,
                rollToday.setScale(2, RoundingMode.HALF_UP),
                paceRatio.setScale(2, RoundingMode.HALF_UP),
                adjustmentFactor.setScale(2, RoundingMode.HALF_UP),
                daysRemaining,
                variableBudget.setScale(2, RoundingMode.HALF_UP),
                variableSpentIncludingToday.setScale(2, RoundingMode.HALF_UP),
                remainingVariableBudget.setScale(2, RoundingMode.HALF_UP),
                danger,
                notes
        );
    }

    private static List<Transaction> filterByDate(List<Transaction> transactions, LocalDate fromInclusive, LocalDate toInclusive) {
        if (transactions == null || transactions.isEmpty()) {
            return List.of();
        }
        return transactions.stream()
                .filter(tx -> !tx.pending())
                .filter(tx -> {
                    LocalDate date = tx.occurredAt().atZone(ZoneOffset.UTC).toLocalDate();
                    return (date.isEqual(fromInclusive) || date.isAfter(fromInclusive))
                            && (date.isEqual(toInclusive) || date.isBefore(toInclusive));
                })
                .toList();
    }

    private BigDecimal deriveVariableBudget(List<Transaction> transactions, CycleWindow window) {
        if (transactions.isEmpty()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal total = transactions.stream()
                .filter(tx -> tx.amount().compareTo(BigDecimal.ZERO) < 0)
                .filter(tx -> isVariableCategory(tx.category()))
                .map(tx -> tx.amount().abs())
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return total.setScale(2, RoundingMode.HALF_UP);
    }

    private Map<LocalDate, BigDecimal> mapVariableSpendByDay(List<Transaction> transactions, CycleWindow window) {
        Map<LocalDate, BigDecimal> byDay = new HashMap<>();
        for (Transaction tx : transactions) {
            if (tx.amount().compareTo(BigDecimal.ZERO) >= 0) {
                continue;
            }
            if (!isVariableCategory(tx.category())) {
                continue;
            }
            LocalDate date = tx.occurredAt().atZone(ZoneOffset.UTC).toLocalDate();
            if (date.isBefore(window.cycleStart()) || date.isAfter(window.cycleEnd())) {
                continue;
            }
            BigDecimal amount = tx.amount().abs();
            byDay.merge(date, amount, BigDecimal::add);
        }
        return byDay;
    }

    private BigDecimal sumVariableSpend(Map<LocalDate, BigDecimal> spendByDay, LocalDate from, LocalDate to) {
        if (spendByDay.isEmpty() || to.isBefore(from)) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal total = BigDecimal.ZERO;
        LocalDate cursor = from;
        while (!cursor.isAfter(to)) {
            total = total.add(spendByDay.getOrDefault(cursor, BigDecimal.ZERO));
            cursor = cursor.plusDays(1);
        }
        return total.setScale(2, RoundingMode.HALF_UP);
    }

    private BigDecimal simulateRoll(BigDecimal variableBudget, Map<LocalDate, BigDecimal> variableSpendByDay, CycleWindow window, LocalDate today) {
        if (window.cycleStart().isAfter(today)) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal roll = BigDecimal.ZERO;
        BigDecimal spentToDate = BigDecimal.ZERO;
        LocalDate cursor = window.cycleStart();
        while (cursor.isBefore(today)) {
            int daysRemaining = Math.max(1, (int) ChronoUnit.DAYS.between(cursor, window.cycleEnd()) + 1);
            BigDecimal remainingBudget = variableBudget.subtract(spentToDate);
            if (remainingBudget.signum() < 0) {
                remainingBudget = BigDecimal.ZERO;
            }
            BigDecimal base = divideSafe(remainingBudget, BigDecimal.valueOf(daysRemaining));
            int elapsed = Math.max(1, (int) ChronoUnit.DAYS.between(window.cycleStart(), cursor));
            int totalDays = Math.max(1, (int) ChronoUnit.DAYS.between(window.cycleStart(), window.cycleEnd()) + 1);
            BigDecimal pace = computePaceRatio(variableBudget, spentToDate, elapsed, totalDays);
            BigDecimal dailyAdjusted = base.multiply(applyAdjustment(pace)).setScale(2, RoundingMode.HALF_UP);

            BigDecimal available = dailyAdjusted.add(roll);
            BigDecimal spent = variableSpendByDay.getOrDefault(cursor, BigDecimal.ZERO);
            BigDecimal leftover = available.subtract(spent);
            if (leftover.signum() > 0) {
                BigDecimal rollIncrement = leftover.multiply(HALF);
                BigDecimal rollCap = base.multiply(ROLL_CAP_MULTIPLIER).setScale(2, RoundingMode.HALF_UP);
                roll = roll.add(rollIncrement);
                if (roll.compareTo(rollCap) > 0) {
                    roll = rollCap;
                }
            } else if (leftover.signum() < 0) {
                BigDecimal overspend = leftover.abs();
                roll = roll.subtract(overspend);
                if (roll.signum() < 0) {
                    roll = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
                }
            }
            spentToDate = spentToDate.add(spent);
            cursor = cursor.plusDays(1);
        }
        return roll.setScale(2, RoundingMode.HALF_UP);
    }

    private static BigDecimal computePaceRatio(BigDecimal variableBudget, BigDecimal spend, int elapsedDays, int totalDays) {
        if (variableBudget.signum() <= 0 || totalDays <= 0) {
            return BigDecimal.ONE.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal plannedDaily = divideSafe(variableBudget, BigDecimal.valueOf(totalDays));
        if (plannedDaily.signum() == 0) {
            return BigDecimal.ONE.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal elapsed = BigDecimal.valueOf(Math.max(elapsedDays, 1));
        BigDecimal actualDaily = divideSafe(spend, elapsed);
        return actualDaily.divide(plannedDaily, 4, RoundingMode.HALF_UP);
    }

    private static BigDecimal applyAdjustment(BigDecimal paceRatio) {
        double ratio = paceRatio.doubleValue();
        double adjusted = 1 - ADJUSTMENT_COEFFICIENT * (ratio - 1);
        adjusted = Math.min(MAX_ADJUST.doubleValue(), Math.max(MIN_ADJUST.doubleValue(), adjusted));
        return BigDecimal.valueOf(adjusted);
    }

    private BigDecimal estimateRemaining(List<Transaction> history, CycleWindow window, LocalDate today,
            java.util.function.Predicate<String> categoryPredicate) {
        Map<String, List<BigDecimal>> amountsByMerchant = new HashMap<>();
        for (Transaction tx : history) {
            if (tx.amount().compareTo(BigDecimal.ZERO) >= 0) {
                continue;
            }
            String category = normalizeCategory(tx.category());
            if (!categoryPredicate.test(category)) {
                continue;
            }
            String merchant = tx.merchantName();
            amountsByMerchant.computeIfAbsent(merchant, key -> new ArrayList<>()).add(tx.amount().abs());
        }
        if (amountsByMerchant.isEmpty()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }

        Map<String, BigDecimal> expectedPerMerchant = new HashMap<>();
        for (Map.Entry<String, List<BigDecimal>> entry : amountsByMerchant.entrySet()) {
            List<BigDecimal> values = entry.getValue();
            if (values.size() < 2) {
                continue;
            }
            values.sort(Comparator.naturalOrder());
            BigDecimal median = median(values);
            expectedPerMerchant.put(entry.getKey(), median);
        }
        if (expectedPerMerchant.isEmpty()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }

        Map<String, BigDecimal> paidThisCycle = new HashMap<>();
        for (Transaction tx : history) {
            if (tx.amount().compareTo(BigDecimal.ZERO) >= 0) {
                continue;
            }
            String merchant = tx.merchantName();
            if (!expectedPerMerchant.containsKey(merchant)) {
                continue;
            }
            LocalDate date = tx.occurredAt().atZone(ZoneOffset.UTC).toLocalDate();
            if (date.isBefore(window.cycleStart()) || date.isAfter(today)) {
                continue;
            }
            String category = normalizeCategory(tx.category());
            if (!categoryPredicate.test(category)) {
                continue;
            }
            paidThisCycle.merge(merchant, tx.amount().abs(), BigDecimal::add);
        }

        BigDecimal remaining = BigDecimal.ZERO;
        for (Map.Entry<String, BigDecimal> entry : expectedPerMerchant.entrySet()) {
            BigDecimal expected = entry.getValue();
            BigDecimal paid = paidThisCycle.getOrDefault(entry.getKey(), BigDecimal.ZERO);
            BigDecimal leftover = expected.subtract(paid);
            if (leftover.signum() > 0) {
                remaining = remaining.add(leftover);
            }
        }
        return remaining.setScale(2, RoundingMode.HALF_UP);
    }

    private BigDecimal sumFutureIncome(List<Transaction> transactions, LocalDate fromExclusive, LocalDate toInclusive) {
        if (transactions.isEmpty()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal total = transactions.stream()
                .filter(tx -> tx.amount().compareTo(BigDecimal.ZERO) > 0)
                .filter(tx -> {
                    LocalDate date = tx.occurredAt().atZone(ZoneOffset.UTC).toLocalDate();
                    return date.isAfter(fromExclusive) && (date.isEqual(toInclusive) || date.isBefore(toInclusive));
                })
                .map(Transaction::amount)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return total.setScale(2, RoundingMode.HALF_UP);
    }

    private static List<String> buildNotes(boolean danger, BigDecimal paceRatio, BigDecimal remainingVariableBudget) {
        List<String> notes = new ArrayList<>();
        if (danger) {
            notes.add("Hard cap exhausted — consider trimming, deferring, or substituting planned spends.");
        }
        if (paceRatio.compareTo(new BigDecimal("1.10")) > 0) {
            notes.add("Variable spend is ahead of plan; dial back discretionary purchases.");
        } else if (paceRatio.compareTo(new BigDecimal("0.80")) < 0) {
            notes.add("Spending is below plan; consider allocating to sinking funds or future goals.");
        }
        if (remainingVariableBudget.signum() <= 0) {
            notes.add("Variable budget fully allocated for this cycle.");
        }
        return notes;
    }

    private static boolean isFixedCategory(String category) {
        if (category == null || category.isBlank()) {
            return false;
        }
        String normalized = normalizeCategory(category);
        return FIXED_CATEGORY_KEYWORDS.stream().anyMatch(normalized::contains);
    }

    private static boolean isSinkingCategory(String category) {
        if (category == null || category.isBlank()) {
            return false;
        }
        String normalized = normalizeCategory(category);
        return SINKING_CATEGORY_KEYWORDS.stream().anyMatch(normalized::contains);
    }

    private static boolean isVariableCategory(String category) {
        return !isFixedCategory(category) && !isSinkingCategory(category);
    }

    private static String normalizeCategory(String category) {
        return category == null ? "" : category.trim().toLowerCase(Locale.ROOT);
    }

    private static BigDecimal divideSafe(BigDecimal numerator, BigDecimal denominator) {
        if (denominator == null || denominator.signum() == 0) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        return numerator.divide(denominator, 2, RoundingMode.HALF_UP);
    }

    private static BigDecimal median(List<BigDecimal> values) {
        if (values.isEmpty()) {
            return BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
        }
        values.sort(Comparator.naturalOrder());
        int size = values.size();
        if (size % 2 == 1) {
            return values.get(size / 2).setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal a = values.get(size / 2 - 1);
        BigDecimal b = values.get(size / 2);
        return a.add(b).divide(BigDecimal.valueOf(2), 2, RoundingMode.HALF_UP);
    }

    private CycleWindow determineCycleWindow(List<Transaction> history, YearMonth focusMonth, LocalDate today) {
        List<LocalDate> incomeDates = history.stream()
                .filter(tx -> tx.amount().compareTo(BigDecimal.ZERO) > 0)
                .map(tx -> tx.occurredAt().atZone(ZoneOffset.UTC).toLocalDate())
                .filter(date -> !date.isAfter(today))
                .sorted()
                .toList();

        LocalDate defaultStart = focusMonth != null
                ? focusMonth.atDay(1)
                : YearMonth.from(today).atDay(1);
        LocalDate cycleStart = incomeDates.isEmpty() ? defaultStart : incomeDates.get(incomeDates.size() - 1);
        LocalDate previousIncome = incomeDates.size() >= 2 ? incomeDates.get(incomeDates.size() - 2) : null;

        int cycleLength = previousIncome != null
                ? Math.max(7, (int) ChronoUnit.DAYS.between(previousIncome, cycleStart))
                : focusMonth != null ? focusMonth.lengthOfMonth() : 30;
        cycleLength = Math.min(cycleLength, 45);
        if (cycleLength <= 0) {
            cycleLength = focusMonth != null ? focusMonth.lengthOfMonth() : 30;
        }

        if (cycleStart.isAfter(today)) {
            cycleStart = today;
        }

        LocalDate cycleEnd = cycleStart.plusDays(cycleLength - 1L);
        while (cycleEnd.isBefore(today)) {
            cycleStart = cycleEnd.plusDays(1);
            cycleEnd = cycleStart.plusDays(cycleLength - 1L);
        }

        LocalDate previousCycleStart = previousIncome != null
                ? previousIncome
                : cycleStart.minusDays(cycleLength);

        return new CycleWindow(cycleStart, cycleEnd, previousCycleStart, cycleLength);
    }

    private record CycleWindow(LocalDate cycleStart, LocalDate cycleEnd, LocalDate previousCycleStart, int cycleLengthDays) {
    }
}
