package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.TransactionResponseDto;
import com.safepocket.ledger.controller.dto.TransactionUpdateRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto.AggregatesDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto.AggregatesDto.SeriesPointDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto.PeriodDto;
import com.safepocket.ledger.controller.dto.TransactionsResetRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsResetResponseDto;
import com.safepocket.ledger.controller.dto.TransactionsSyncRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsSyncResponseDto;
import com.safepocket.ledger.model.AnomalyScore;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.service.TransactionService;
import com.safepocket.ledger.service.TransactionSyncService;
import com.safepocket.ledger.service.TransactionMaintenanceService;
import jakarta.validation.Valid;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/transactions")
public class TransactionsController {

    private final TransactionService transactionService;
    private final TransactionSyncService transactionSyncService;
    private final TransactionMaintenanceService transactionMaintenanceService;

    public TransactionsController(
            TransactionService transactionService,
            TransactionSyncService transactionSyncService,
            TransactionMaintenanceService transactionMaintenanceService
    ) {
        this.transactionService = transactionService;
        this.transactionSyncService = transactionSyncService;
        this.transactionMaintenanceService = transactionMaintenanceService;
    }

    @GetMapping
    public ResponseEntity<TransactionsListResponseDto> listTransactions(
            @RequestParam(value = "month", required = false) String month,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "accountId", required = false) String accountId
    ) {
        var window = resolveWindow(month, from, to);
        Optional<UUID> accountUuid = Optional.ofNullable(accountId).filter(value -> !value.isBlank()).map(UUID::fromString);
        var result = transactionService.listTransactions(window.fromDate(), window.toDate(), window.month(), accountUuid);
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        AggregatesDto aggregates = buildAggregates(result.transactions(), window);
        var response = new TransactionsListResponseDto(
                new PeriodDto(
                        result.month().map(YearMonth::toString).orElse(null),
                        window.fromProvided() ? result.from() : null,
                        window.toProvided() ? result.to() : null
                ),
                aggregates,
                result.transactions().stream().map(this::map).toList(),
                traceId
        );
        return ResponseEntity.ok(response);
    }

    @PatchMapping("/{transactionId}")
    public ResponseEntity<TransactionResponseDto> updateTransaction(
            @PathVariable("transactionId") UUID transactionId,
            @RequestBody @Valid TransactionUpdateRequestDto request
    ) {
        var updated = transactionService.updateTransaction(transactionId,
                Optional.ofNullable(request.category()),
                Optional.ofNullable(request.notes()));
        return ResponseEntity.ok(map(updated));
    }

    @PostMapping("/sync")
    public ResponseEntity<TransactionsSyncResponseDto> syncTransactions(
            @RequestBody(required = false) TransactionsSyncRequestDto request
    ) {
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
    boolean forceFullSync = request != null && request.forceFullSyncFlag();
    boolean demoSeed = request != null && request.demoSeedFlag();
    Optional<LocalDate> startDate = request != null ? request.startDateValue() : Optional.empty();
        var result = transactionSyncService.triggerSync(forceFullSync, demoSeed, startDate, traceId);
        var response = new TransactionsSyncResponseDto(result.status(), result.syncedCount(), result.pendingCount(), result.traceId());
        return ResponseEntity.accepted().body(response);
    }

    @PostMapping("/reset")
    public ResponseEntity<TransactionsResetResponseDto> resetTransactions(
            @RequestBody(required = false) TransactionsResetRequestDto request
    ) {
        boolean unlinkPlaid = request != null && request.unlinkPlaidFlag();
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        transactionMaintenanceService.resetTransactions(unlinkPlaid);
        return ResponseEntity.accepted().body(new TransactionsResetResponseDto("ACCEPTED", traceId));
    }

    private TransactionResponseDto map(Transaction transaction) {
        TransactionResponseDto.AnomalyScoreDto anomalyScoreDto = transaction.anomalyScore()
                .map(this::map)
                .orElse(null);
        return new TransactionResponseDto(
                transaction.id().toString(),
                transaction.userId().toString(),
                transaction.accountId().toString(),
                transaction.merchantName(),
                transaction.amount(),
                transaction.currency(),
                transaction.occurredAt(),
                transaction.authorizedAt(),
                transaction.pending(),
                transaction.category(),
                transaction.description(),
                anomalyScoreDto,
                transaction.notes().orElse(null)
        );
    }

    private TransactionResponseDto.AnomalyScoreDto map(AnomalyScore score) {
        return new TransactionResponseDto.AnomalyScoreDto(
                score.method().name(),
                score.deltaAmount(),
                score.budgetImpactPercent(),
                score.commentary()
        );
    }

    private AggregatesDto buildAggregates(List<Transaction> transactions, TransactionWindow window) {
        if (transactions.isEmpty()) {
            boolean includeDaily = window.month().isPresent();
            return new AggregatesDto(
                    BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP),
                    BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP),
                    BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP),
                    Map.of(),
                    includeDaily ? Map.of() : null,
                    List.of(),
                    includeDaily ? List.of() : null,
                    List.of(),
                    includeDaily ? TrendGranularity.DAY.name() : TrendGranularity.MONTH.name(),
                    Map.of(),
                    0
            );
        }

        boolean includeDaily = window.month().isPresent();
        BigDecimal incomeTotal = BigDecimal.ZERO;
        BigDecimal expenseTotal = BigDecimal.ZERO;
        Map<String, BigDecimal> monthNet = new LinkedHashMap<>();
        Map<String, BigDecimal> dayNet = includeDaily ? new LinkedHashMap<>() : null;
        Map<String, BigDecimal> categoryTotals = new LinkedHashMap<>();
        DateTimeFormatter monthFormatter = DateTimeFormatter.ofPattern("yyyy-MM").withZone(ZoneOffset.UTC);
        DateTimeFormatter dayFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC);
        TreeMap<String, BigDecimal> timelineTotals = new TreeMap<>();
        LocalDate minDate = null;
        LocalDate maxDate = null;

        for (Transaction transaction : transactions) {
            BigDecimal amount = transaction.amount() != null ? transaction.amount() : BigDecimal.ZERO;
            BigDecimal scaledAmount = amount.setScale(2, RoundingMode.HALF_UP);
            if (scaledAmount.compareTo(BigDecimal.ZERO) > 0) {
                incomeTotal = incomeTotal.add(scaledAmount);
            } else if (scaledAmount.compareTo(BigDecimal.ZERO) < 0) {
                expenseTotal = expenseTotal.add(scaledAmount);
            }

            if (transaction.occurredAt() != null) {
                String monthKey = monthFormatter.format(transaction.occurredAt());
                monthNet.merge(monthKey, scaledAmount, BigDecimal::add);
                LocalDate occurredDate = transaction.occurredAt().atOffset(ZoneOffset.UTC).toLocalDate();
                minDate = minDate == null || occurredDate.isBefore(minDate) ? occurredDate : minDate;
                maxDate = maxDate == null || occurredDate.isAfter(maxDate) ? occurredDate : maxDate;
                if (dayNet != null) {
                    String dayKey = dayFormatter.format(transaction.occurredAt());
                    dayNet.merge(dayKey, scaledAmount, BigDecimal::add);
                }
                // timeline totals will use placeholder key; final granularity decided later
                timelineTotals.merge(occurredDate.toString(), scaledAmount, BigDecimal::add);
            }

            if (scaledAmount.compareTo(BigDecimal.ZERO) < 0) {
                String category = Optional.ofNullable(transaction.category())
                        .map(String::trim)
                        .filter(value -> !value.isEmpty())
                        .orElse("Uncategorised");
                categoryTotals.merge(category, scaledAmount, BigDecimal::add);
            }
        }

        BigDecimal netTotal = incomeTotal.add(expenseTotal).setScale(2, RoundingMode.HALF_UP);
        Map<String, BigDecimal> normalisedMonthNet = monthNet.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        entry -> entry.getValue().setScale(2, RoundingMode.HALF_UP),
                        (left, right) -> right,
                        LinkedHashMap::new
                ));
        List<SeriesPointDto> monthSeries = normalisedMonthNet.entrySet().stream()
                .map(entry -> new SeriesPointDto(entry.getKey(), entry.getValue()))
                .toList();

        Map<String, BigDecimal> normalisedDayNet = null;
        List<SeriesPointDto> daySeries = null;
        if (dayNet != null) {
            normalisedDayNet = dayNet.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .collect(Collectors.toMap(
                            Map.Entry::getKey,
                            entry -> entry.getValue().setScale(2, RoundingMode.HALF_UP),
                            (left, right) -> right,
                            LinkedHashMap::new
                    ));
            daySeries = normalisedDayNet.entrySet().stream()
                    .map(entry -> new SeriesPointDto(entry.getKey(), entry.getValue()))
                    .toList();
        }

        Map<String, BigDecimal> normalisedCategoryTotals = categoryTotals.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        entry -> entry.getValue().setScale(2, RoundingMode.HALF_UP),
                        (left, right) -> right,
                        LinkedHashMap::new
                ));

        TrendGranularity trendGranularity = determineTrendGranularity(includeDaily, minDate, maxDate);
        List<SeriesPointDto> trendSeries = aggregateTimeline(timelineTotals, trendGranularity);

        return new AggregatesDto(
                incomeTotal.setScale(2, RoundingMode.HALF_UP),
                expenseTotal.setScale(2, RoundingMode.HALF_UP),
                netTotal,
                normalisedMonthNet,
                normalisedDayNet,
                monthSeries,
                daySeries,
                trendSeries,
                trendGranularity.name(),
                normalisedCategoryTotals,
                transactions.size()
        );
    }

    private TrendGranularity determineTrendGranularity(boolean includeDaily, LocalDate minDate, LocalDate maxDate) {
        if (includeDaily) {
            return TrendGranularity.DAY;
        }
        if (minDate == null || maxDate == null) {
            return TrendGranularity.MONTH;
        }
        long days = ChronoUnit.DAYS.between(minDate, maxDate) + 1;
        if (days <= 120) {
            return TrendGranularity.WEEK;
        }
        if (days <= 730) {
            return TrendGranularity.MONTH;
        }
        return TrendGranularity.QUARTER;
    }

    private List<SeriesPointDto> aggregateTimeline(Map<String, BigDecimal> dailyTotals, TrendGranularity granularity) {
        if (dailyTotals.isEmpty()) {
            return List.of();
        }
        Map<String, BigDecimal> buckets = new TreeMap<>();
        DateTimeFormatter dayFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");

        for (Map.Entry<String, BigDecimal> entry : dailyTotals.entrySet()) {
            LocalDate date = LocalDate.parse(entry.getKey(), dayFormatter);
            String key = switch (granularity) {
                case DAY -> date.toString();
                case WEEK -> date.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString();
                case MONTH -> YearMonth.from(date).toString();
                case QUARTER -> {
                    int quarter = ((date.getMonthValue() - 1) / 3) + 1;
                    yield date.getYear() + "-Q" + quarter;
                }
            };
            buckets.merge(key, entry.getValue(), BigDecimal::add);
        }

        return buckets.entrySet().stream()
                .map(entry -> new SeriesPointDto(entry.getKey(), entry.getValue().setScale(2, RoundingMode.HALF_UP)))
                .toList();
    }

    private static TransactionWindow resolveWindow(String month, String from, String to) {
        boolean hasFrom = from != null && !from.isBlank();
        boolean hasTo = to != null && !to.isBlank();
        boolean hasMonth = month != null && !month.isBlank();

        if (hasFrom || hasTo) {
            YearMonth fromMonth = hasFrom ? parseMonth(from, "from") : null;
            YearMonth toMonth = hasTo ? parseMonth(to, "to") : null;
            LocalDate fromDate = fromMonth != null ? fromMonth.atDay(1) : LocalDate.of(1970, 1, 1);
            LocalDate toDate = toMonth != null ? toMonth.plusMonths(1).atDay(1) : LocalDate.now().plusDays(1);
            if (!toDate.isAfter(fromDate)) {
                throw new IllegalArgumentException("to must be after from");
            }
            return new TransactionWindow(Optional.empty(), fromDate, toDate, hasFrom, hasTo);
        }

        if (hasMonth) {
            YearMonth targetMonth = parseMonth(month, "month");
            LocalDate fromDate = targetMonth.atDay(1);
            LocalDate toDate = targetMonth.plusMonths(1).atDay(1);
            return new TransactionWindow(Optional.of(targetMonth), fromDate, toDate, true, true);
        }

        LocalDate fromDate = LocalDate.of(1970, 1, 1);
        LocalDate toDate = LocalDate.now().plusDays(1);
        return new TransactionWindow(Optional.empty(), fromDate, toDate, false, false);
    }

    private record TransactionWindow(Optional<YearMonth> month, LocalDate fromDate, LocalDate toDate, boolean fromProvided, boolean toProvided) {
    }

    private static YearMonth parseMonth(String value, String param) {
        try {
            return YearMonth.parse(value);
        } catch (DateTimeParseException ex) {
            throw new IllegalArgumentException("Invalid " + param + " format");
        }
    }

    private enum TrendGranularity {
        DAY,
        WEEK,
        MONTH,
        QUARTER
    }
}
