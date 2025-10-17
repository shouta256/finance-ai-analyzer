package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.TransactionResponseDto;
import com.safepocket.ledger.controller.dto.TransactionUpdateRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto;
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
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.Optional;
import java.util.UUID;
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
        var response = new TransactionsListResponseDto(
                new PeriodDto(
                        result.month().map(YearMonth::toString).orElse(null),
                        window.fromProvided() ? result.from() : null,
                        window.toProvided() ? result.to() : null
                ),
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
}
