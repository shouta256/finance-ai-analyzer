package com.safepocket.ledger.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;

/**
 * Returns consistent JSON error bodies for 401 / 403 responses so the frontend can surface
 * precise diagnostics (audience mismatch, issuer mismatch, expired token, etc.).
 */
@Component
public class JsonAuthErrorHandlers implements AuthenticationEntryPoint, AccessDeniedHandler {

    private static final Logger log = LoggerFactory.getLogger(JsonAuthErrorHandlers.class);
    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException authException) throws IOException {
        // 401
        writeJson(response, 401, authException, request, "UNAUTHORIZED");
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, org.springframework.security.access.AccessDeniedException accessDeniedException) throws IOException {
        // 403
        writeJson(response, 403, accessDeniedException, request, "FORBIDDEN");
    }

    private void writeJson(HttpServletResponse response, int status, Exception ex, HttpServletRequest request, String code) throws IOException {
        if (response.isCommitted()) {
            return; // nothing to do
        }
        response.setStatus(status);
        response.setContentType("application/json;charset=UTF-8");

        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        String oauth2ErrorCode = null;
        String oauth2ErrorDescription = null;
        if (ex instanceof OAuth2AuthenticationException oauthEx && oauthEx.getError() != null) {
            oauth2ErrorCode = oauthEx.getError().getErrorCode();
            oauth2ErrorDescription = oauthEx.getError().getDescription();
        }

        Map<String, Object> body = new HashMap<>();
        Map<String, Object> err = new HashMap<>();
        err.put("code", code);
        err.put("message", ex.getMessage());
        err.put("oauth2ErrorCode", oauth2ErrorCode);
        err.put("oauth2ErrorDescription", oauth2ErrorDescription);
        err.put("traceId", traceId);
        err.put("path", request.getRequestURI());
        err.put("timestamp", Instant.now().toString());
        body.put("error", err);

        log.warn("Auth failure status={} code={} oauth2Code={} desc={} path={} traceId={} msg={}", status, code, oauth2ErrorCode, oauth2ErrorDescription, request.getRequestURI(), traceId, ex.getMessage());
        mapper.writeValue(response.getOutputStream(), body);
    }
}
