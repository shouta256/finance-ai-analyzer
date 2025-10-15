package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.AccountResponseDto;
import com.safepocket.ledger.controller.dto.AccountsListResponseDto;
import com.safepocket.ledger.model.AccountSummary;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RequestContextHolder;
import com.safepocket.ledger.service.AccountService;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/accounts")
public class AccountsController {

    private static final BigDecimal ZERO = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);

    private final AccountService accountService;
    private final AuthenticatedUserProvider authenticatedUserProvider;

    public AccountsController(
            AccountService accountService,
            AuthenticatedUserProvider authenticatedUserProvider
    ) {
        this.accountService = accountService;
        this.authenticatedUserProvider = authenticatedUserProvider;
    }

    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public AccountsListResponseDto listAccounts() {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        List<AccountSummary> summaries = accountService.listAccounts(userId);
        List<AccountResponseDto> accounts = summaries.stream()
                .map(summary -> new AccountResponseDto(
                        summary.id(),
                        summary.name(),
                        summary.institution(),
                        summary.type().orElse(null),
                        summary.balance(),
                        summary.currency(),
                        summary.createdAt(),
                        summary.lastTransactionAt().orElse(null),
                        summary.linkedAt().orElse(null)
                ))
                .toList();

        BigDecimal totalBalance = summaries.stream()
                .map(AccountSummary::balance)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);

        String currency = summaries.stream()
                .map(AccountSummary::currency)
                .findFirst()
                .orElse("USD");

        String traceId = RequestContextHolder.get()
                .map(RequestContextHolder.RequestContext::traceId)
                .orElse(null);

        return new AccountsListResponseDto(
                currency,
                summaries.isEmpty() ? ZERO : totalBalance,
                accounts,
                traceId
        );
    }
}
