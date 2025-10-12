package com.safepocket.ledger.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Arrays;

/**
 * Development helper: upgrade the dev cookie (sp_token) into an Authorization: Bearer header.
 * If the request already has Authorization, we keep it untouched.
 */
public class CookieBearerTokenFilter extends OncePerRequestFilter {
    public static final String PRIMARY_COOKIE = "sp_token";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        if (hasAuthHeader(request)) {
            filterChain.doFilter(request, response);
            return;
        }
        HttpServletRequest current = request;
        if (current.getCookies() != null) {
            String token = Arrays.stream(current.getCookies())
                    .filter(c -> PRIMARY_COOKIE.equals(c.getName()))
                    .findFirst()
                    .map(Cookie::getValue)
                    .filter(StringUtils::hasText)
                    .orElse(null);
            if (token != null) {
                current = new HttpServletRequestWrapperWithAuth(current, token);
            }
        }
        filterChain.doFilter(current, response);
    }

    private boolean hasAuthHeader(HttpServletRequest request) {
        String h = request.getHeader(HttpHeaders.AUTHORIZATION);
        return h != null && !h.isBlank();
    }
}

class HttpServletRequestWrapperWithAuth extends HttpServletRequestWrapper {
    private final String token;

    HttpServletRequestWrapperWithAuth(HttpServletRequest request, String token) {
        super(request);
        this.token = token;
    }

    @Override
    public String getHeader(String name) {
        if (HttpHeaders.AUTHORIZATION.equalsIgnoreCase(name)) {
            return "Bearer " + token;
        }
        return super.getHeader(name);
    }
}
