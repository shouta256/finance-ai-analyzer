package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.PlaidExchangeRequestDto;
import com.safepocket.ledger.controller.dto.PlaidExchangeResponseDto;
import com.safepocket.ledger.controller.dto.PlaidLinkTokenResponseDto;
import com.safepocket.ledger.plaid.PlaidItem;
import com.safepocket.ledger.plaid.PlaidLinkToken;
import com.safepocket.ledger.plaid.PlaidService;
import com.safepocket.ledger.security.AuthenticatedUserProvider;
import com.safepocket.ledger.security.RequestContextHolder;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/plaid")
public class PlaidController {

    private final PlaidService plaidService;
    private final AuthenticatedUserProvider authenticatedUserProvider;

    public PlaidController(PlaidService plaidService, AuthenticatedUserProvider authenticatedUserProvider) {
        this.plaidService = plaidService;
        this.authenticatedUserProvider = authenticatedUserProvider;
    }

    @PostMapping("/link-token")
    public ResponseEntity<PlaidLinkTokenResponseDto> createLinkToken() {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        PlaidLinkToken linkToken = plaidService.createLinkToken(userId);
        return ResponseEntity.ok(new PlaidLinkTokenResponseDto(linkToken.linkToken(), linkToken.expiration(), linkToken.requestId()));
    }

    @PostMapping("/exchange")
    public ResponseEntity<PlaidExchangeResponseDto> exchangePublicToken(@RequestBody @Valid PlaidExchangeRequestDto request) {
        UUID userId = authenticatedUserProvider.requireCurrentUserId();
        PlaidItem item = plaidService.exchangePublicToken(userId, request.publicToken());
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        return ResponseEntity.ok(new PlaidExchangeResponseDto(item.itemId(), "SUCCESS", traceId));
    }
}
