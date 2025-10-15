package com.safepocket.ledger.controller;

import com.safepocket.ledger.auth.CognitoAuthService;
import com.safepocket.ledger.controller.dto.AuthTokenRequestDto;
import com.safepocket.ledger.controller.dto.AuthTokenResponseDto;
import com.safepocket.ledger.security.RequestContextHolder;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/auth/token")
public class AuthTokenController {

    private final CognitoAuthService cognitoAuthService;

    public AuthTokenController(CognitoAuthService cognitoAuthService) {
        this.cognitoAuthService = cognitoAuthService;
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public AuthTokenResponseDto exchange(@RequestBody AuthTokenRequestDto request) {
        CognitoAuthService.TokenExchangeRequest command = new CognitoAuthService.TokenExchangeRequest(
                request.grantType(),
                request.code(),
                request.redirectUri(),
                request.codeVerifier(),
                request.refreshToken()
        );
        CognitoAuthService.AuthTokenResult result = cognitoAuthService.exchange(command);
        String traceId = RequestContextHolder.get()
                .map(RequestContextHolder.RequestContext::traceId)
                .orElse(null);
        return new AuthTokenResponseDto(
                result.accessToken(),
                result.idToken(),
                result.refreshToken(),
                result.expiresIn(),
                result.tokenType(),
                result.scope(),
                result.userId().orElse(null),
                traceId
        );
    }
}
