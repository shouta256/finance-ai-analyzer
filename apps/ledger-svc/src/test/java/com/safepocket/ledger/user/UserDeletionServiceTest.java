package com.safepocket.ledger.user;

import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;

import com.safepocket.ledger.ai.AiHighlightRepository;
import com.safepocket.ledger.chat.ChatMessageRepository;
import com.safepocket.ledger.plaid.PlaidItemRepository;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.repository.TransactionRepository;
import com.safepocket.ledger.security.RlsGuard;
import com.safepocket.ledger.service.TransactionSyncService;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.EmptyResultDataAccessException;

@ExtendWith(MockitoExtension.class)
class UserDeletionServiceTest {

    @Mock
    RlsGuard rlsGuard;
    @Mock
    TransactionRepository transactionRepository;
    @Mock
    JpaAccountRepository accountRepository;
    @Mock
    ChatMessageRepository chatMessageRepository;
    @Mock
    PlaidItemRepository plaidItemRepository;
    @Mock
    AiHighlightRepository aiHighlightRepository;
    @Mock
    UserRepository userRepository;
    @Mock
    TransactionSyncService transactionSyncService;

    UserDeletionService service;

    @BeforeEach
    void setUp() {
        service = new UserDeletionService(
                rlsGuard,
                transactionRepository,
                accountRepository,
                chatMessageRepository,
                plaidItemRepository,
                aiHighlightRepository,
                userRepository,
                transactionSyncService
        );
    }

    @Test
    void deleteUserRemovesAssociatedData() {
        UUID userId = UUID.randomUUID();

        service.deleteUser(userId);

        verify(rlsGuard).setAppsecUser(userId);
        verify(chatMessageRepository).deleteByUserId(userId);
        verify(transactionRepository).deleteByUserId(userId);
        verify(accountRepository).deleteByUserId(userId);
        verify(plaidItemRepository).deleteByUserId(userId);
        verify(aiHighlightRepository).deleteById(userId);
        verify(transactionSyncService).clearUserSyncState(userId);
        verify(userRepository).deleteById(userId);
        verifyNoMoreInteractions(
                chatMessageRepository,
                transactionRepository,
                accountRepository,
                plaidItemRepository,
                aiHighlightRepository,
                transactionSyncService,
                userRepository
        );
    }

    @Test
    void deleteUserHandlesMissingUserRecord() {
        UUID userId = UUID.randomUUID();
        doThrow(new EmptyResultDataAccessException(1)).when(userRepository).deleteById(userId);

        service.deleteUser(userId);

        verify(userRepository).deleteById(userId);
    }
}
