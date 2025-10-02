package com.safepocket.ledger.service;

import com.safepocket.ledger.analytics.AnomalyDetectionService;
import com.safepocket.ledger.model.AnalyticsSummary;
import com.safepocket.ledger.model.AnomalyScore;
import com.safepocket.ledger.model.Transaction;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.YearMonth;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionService {

    private final TransactionRepository transactionRepository;
    private final AuthenticatedUserProvider authenticatedUserProvider;
    private final RlsGuard rlsGuard;
    private final AnomalyDetectionService anomalyDetectionService;

    public TransactionService(
            TransactionRepository transactionRepository,
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard,
            AnomalyDetectionService anomalyDetectionService
    ) {
        this.transactionRepository = transactionRepository;
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
        this.anomalyDetectionService = anomalyDetectionService;
    }

    @Transactional(readOnly = true)
    public List<Transaction> listTransactions(YearMonth month, Optional<UUID> accountId) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        List<Transaction> transactions = accountId
                .map(uuid -> transactionRepository.findByUserIdAndMonthAndAccount(userId, month, uuid))
                .orElseGet(() -> transactionRepository.findByUserIdAndMonth(userId, month));
        var anomalies = anomalyDetectionService.detectAnomalies(transactions).stream()
                .collect(Collectors.toMap(AnalyticsSummary.AnomalyInsight::transactionId, insight -> insight));
        return transactions.stream()
                .map(tx -> annotateWithAnomaly(tx, anomalies.get(tx.id().toString())))
                .toList();
    }

    @Transactional
    public Transaction updateTransaction(UUID transactionId, Optional<String> category, Optional<String> notes) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        Transaction existing = transactionRepository.findById(transactionId)
                .filter(tx -> tx.userId().equals(userId))
                .orElseThrow(() -> new IllegalArgumentException("Transaction not found"));
        Transaction updated = existing;
        if (category.isPresent()) {
            updated = updated.withCategory(category.get());
        }
        if (notes.isPresent()) {
            updated = updated.withNotes(notes.get());
        }
        return transactionRepository.save(updated);
    }

    private Transaction annotateWithAnomaly(Transaction transaction, AnalyticsSummary.AnomalyInsight insight) {
        if (insight == null) {
            return transaction;
        }
        BigDecimal zScore = insight.score().setScale(2, RoundingMode.HALF_UP);
        AnomalyScore score = new AnomalyScore(
                insight.method(),
                zScore,
                insight.amount().abs().setScale(2, RoundingMode.HALF_UP),
                insight.commentary()
        );
        return transaction.withAnomalyScore(score);
    }
}
