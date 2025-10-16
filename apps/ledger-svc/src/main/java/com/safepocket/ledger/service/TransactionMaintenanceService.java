package com.safepocket.ledger.service;

import com.safepocket.ledger.plaid.PlaidService;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.rag.TransactionEmbeddingService;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RlsGuard;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionMaintenanceService {

    private final TransactionRepository transactionRepository;
    private final TransactionEmbeddingService transactionEmbeddingService;
    private final PlaidService plaidService;
    private final TransactionSyncService transactionSyncService;
    private final AuthenticatedUserProvider authenticatedUserProvider;
    private final RlsGuard rlsGuard;

    public TransactionMaintenanceService(
            TransactionRepository transactionRepository,
            TransactionEmbeddingService transactionEmbeddingService,
            PlaidService plaidService,
            TransactionSyncService transactionSyncService,
            AuthenticatedUserProvider authenticatedUserProvider,
            RlsGuard rlsGuard
    ) {
        this.transactionRepository = transactionRepository;
        this.transactionEmbeddingService = transactionEmbeddingService;
        this.plaidService = plaidService;
        this.transactionSyncService = transactionSyncService;
        this.authenticatedUserProvider = authenticatedUserProvider;
        this.rlsGuard = rlsGuard;
    }

    @Transactional
    public void resetTransactions(boolean unlinkPlaid) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        rlsGuard.setAppsecUser(userId);
        transactionEmbeddingService.deleteAll(userId);
        transactionRepository.deleteByUserId(userId);
        transactionSyncService.clearUserSyncState(userId);
        if (unlinkPlaid) {
            plaidService.unlink(userId);
        }
    }
}
