package com.safepocket.ledger.user;

import com.safepocket.ledger.ai.AiHighlightRepository;
import com.safepocket.ledger.chat.ChatMessageRepository;
import com.safepocket.ledger.plaid.PlaidItemRepository;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.RlsGuard;
import com.safepocket.ledger.service.TransactionSyncService;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserDeletionService {

    private static final Logger log = LoggerFactory.getLogger(UserDeletionService.class);

    private final RlsGuard rlsGuard;
    private final TransactionRepository transactionRepository;
    private final JpaAccountRepository accountRepository;
    private final ChatMessageRepository chatMessageRepository;
    private final PlaidItemRepository plaidItemRepository;
    private final AiHighlightRepository aiHighlightRepository;
    private final UserRepository userRepository;
    private final TransactionSyncService transactionSyncService;

    public UserDeletionService(
            RlsGuard rlsGuard,
            TransactionRepository transactionRepository,
            JpaAccountRepository accountRepository,
            ChatMessageRepository chatMessageRepository,
            PlaidItemRepository plaidItemRepository,
            AiHighlightRepository aiHighlightRepository,
            UserRepository userRepository,
            TransactionSyncService transactionSyncService
    ) {
        this.rlsGuard = rlsGuard;
        this.transactionRepository = transactionRepository;
        this.accountRepository = accountRepository;
        this.chatMessageRepository = chatMessageRepository;
        this.plaidItemRepository = plaidItemRepository;
        this.aiHighlightRepository = aiHighlightRepository;
        this.userRepository = userRepository;
        this.transactionSyncService = transactionSyncService;
    }

    @Transactional
    public void deleteUser(UUID userId) {
        rlsGuard.setAppsecUser(userId);

        chatMessageRepository.deleteByUserId(userId);
        transactionRepository.deleteByUserId(userId);
        accountRepository.deleteByUserId(userId);
        plaidItemRepository.deleteByUserId(userId);
        aiHighlightRepository.deleteByUserId(userId);

        transactionSyncService.clearUserSyncState(userId);

        try {
            userRepository.deleteById(userId);
        } catch (EmptyResultDataAccessException ex) {
            log.debug("User {} already deleted, continuing cleanup", userId);
        }
    }
}
