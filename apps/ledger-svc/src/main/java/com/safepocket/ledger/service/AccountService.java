package com.safepocket.ledger.service;

import com.safepocket.ledger.model.AccountSummary;
import com.safepocket.ledger.plaid.PlaidItemRepository;
import com.safepocket.ledger.repository.AccountBalanceProjection;
import com.safepocket.ledger.repository.JpaAccountRepository;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.security.RlsGuard;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    private static final BigDecimal ZERO = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);
    private static final String DEFAULT_CURRENCY = "USD";

    private final JpaAccountRepository accountRepository;
    private final PlaidItemRepository plaidItemRepository;
    private final RlsGuard rlsGuard;

    public AccountService(
            JpaAccountRepository accountRepository,
            PlaidItemRepository plaidItemRepository,
            RlsGuard rlsGuard
    ) {
        this.accountRepository = accountRepository;
        this.plaidItemRepository = plaidItemRepository;
        this.rlsGuard = rlsGuard;
    }

    @Transactional(readOnly = true)
    public List<AccountSummary> listAccounts(UUID userId) {
        rlsGuard.setAppsecUser(userId);
        RequestContextHolder.setUserId(userId);

        List<AccountBalanceProjection> projections = accountRepository.findSummariesByUserId(userId);
        Instant linkedAt = plaidItemRepository.findByUserId(userId)
                .map(entity -> entity.getLinkedAt())
                .orElse(null);

        return projections.stream()
                .map(row -> new AccountSummary(
                        row.id(),
                        row.userId(),
                        row.name(),
                        row.institution(),
                        Optional.empty(),
                        normalize(row.balance()),
                        DEFAULT_CURRENCY,
                        row.createdAt(),
                        Optional.ofNullable(row.lastTransactionAt()),
                        Optional.ofNullable(linkedAt)
                ))
                .toList();
    }

    private BigDecimal normalize(BigDecimal value) {
        if (value == null) {
            return ZERO;
        }
        return value.setScale(2, RoundingMode.HALF_UP);
    }
}
