package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.TransactionResponseDto;
import com.safepocket.ledger.controller.dto.TransactionUpdateRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsListResponseDto;
import com.safepocket.ledger.controller.dto.TransactionsSyncRequestDto;
import com.safepocket.ledger.controller.dto.TransactionsSyncResponseDto;
import com.safepocket.ledger.model.AnomalyScore;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.service.TransactionService;
import com.safepocket.ledger.service.TransactionSyncService;
import jakarta.validation.Valid;
import java.time.YearMonth;
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

    public TransactionsController(TransactionService transactionService, TransactionSyncService transactionSyncService) {
        this.transactionService = transactionService;
        this.transactionSyncService = transactionSyncService;
    }

    @GetMapping
    public ResponseEntity<TransactionsListResponseDto> listTransactions(
            @RequestParam("month") String month,
            @RequestParam(value = "accountId", required = false) String accountId
    ) {
        YearMonth yearMonth = YearMonth.parse(month);
        Optional<UUID> accountUuid = Optional.ofNullable(accountId).filter(value -> !value.isBlank()).map(UUID::fromString);
        var transactions = transactionService.listTransactions(yearMonth, accountUuid);
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        var response = new TransactionsListResponseDto(
                month,
                transactions.stream().map(this::map).toList(),
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
        var result = transactionSyncService.triggerSync(forceFullSync, demoSeed, traceId);
        var response = new TransactionsSyncResponseDto(result.status(), result.syncedCount(), result.pendingCount(), result.traceId());
        return ResponseEntity.accepted().body(response);
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
}
