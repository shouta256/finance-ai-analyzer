package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.ErrorResponseDto;
import com.safepocket.ledger.security.RequestContextHolder;
import jakarta.validation.ConstraintViolationException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import org.springframework.web.reactive.function.client.WebClientRequestException;

@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ErrorResponseDto> handleIllegalArgument(IllegalArgumentException ex) {
        return build(HttpStatus.BAD_REQUEST, "INVALID_ARGUMENT", ex.getMessage(), Map.of());
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, ConstraintViolationException.class})
    public ResponseEntity<ErrorResponseDto> handleValidation(Exception ex) {
        return build(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", ex.getMessage(), Map.of());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponseDto> handleGeneral(Exception ex) {
        // Detect missing table (schema not initialized) -> provide specific guidance
        String msg = ex.getMessage() != null ? ex.getMessage().toLowerCase() : "";
        if (msg.contains("relation \"transactions\" does not exist") || msg.contains("relation \"accounts\" does not exist")) {
            return build(HttpStatus.INTERNAL_SERVER_ERROR, "DB_SCHEMA_MISSING", "Database schema not initialized", Map.of(
                    "action", "Enable SAFEPOCKET_DB_BOOTSTRAP=true once or run schema DDL (see docs/operations.md)",
                    "reason", ex.getMessage()
            ));
        }
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Unexpected error", Map.of("reason", ex.getMessage()));
    }

    // --- Upstream (Plaid/WebClient) mapping ---
    @ExceptionHandler(WebClientResponseException.class)
    public ResponseEntity<ErrorResponseDto> handleWebClientResponse(WebClientResponseException ex) {
        HttpStatus status = HttpStatus.resolve(ex.getRawStatusCode());
        if (status == null) status = HttpStatus.BAD_GATEWAY;
        String body = ex.getResponseBodyAsString();
        return build(status,
                "PLAID_UPSTREAM_ERROR",
                "Plaid API response error",
                Map.of(
                        "status", ex.getRawStatusCode(),
                        "reason", ex.getMessage(),
                        "body", body == null || body.isBlank() ? null : body
                ));
    }

    @ExceptionHandler(WebClientRequestException.class)
    public ResponseEntity<ErrorResponseDto> handleWebClientRequest(WebClientRequestException ex) {
        return build(HttpStatus.BAD_GATEWAY,
                "PLAID_CONNECT_ERROR",
                "Failed to connect to Plaid API",
                Map.of(
                        "reason", ex.getMessage()
                ));
    }

    @ExceptionHandler(BadSqlGrammarException.class)
    public ResponseEntity<ErrorResponseDto> handleBadSql(BadSqlGrammarException ex) {
        var sqlEx = ex.getSQLException();
        String sqlState = sqlEx != null ? sqlEx.getSQLState() : null;
        String pgMsg = sqlEx != null ? sqlEx.getMessage() : ex.getMessage();
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "SQL_GRAMMAR_ERROR", "Bad SQL grammar",
                Map.of(
                        "sql", ex.getSql(),
                        "sqlState", sqlState,
                        "reason", pgMsg
                ));
    }

    @ExceptionHandler(CannotGetJdbcConnectionException.class)
    public ResponseEntity<ErrorResponseDto> handleJdbc(CannotGetJdbcConnectionException ex) {
    String specific = ex.getMostSpecificCause() != null ? ex.getMostSpecificCause().getMessage() : ex.getMessage();
    String msgLower = specific != null ? specific.toLowerCase() : "";
    if (msgLower.contains("does not exist") && msgLower.contains("database")) {
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "DB_NOT_FOUND", "Configured database does not exist", Map.of(
            "reason", specific,
            "action", "Create the database (CREATE DATABASE safepocket) or correct SPRING_DATASOURCE_URL"
        ));
    }
    return build(HttpStatus.SERVICE_UNAVAILABLE, "DB_UNAVAILABLE", "Database temporarily unavailable", Map.of(
        "reason", specific
    ));
    }

    private ResponseEntity<ErrorResponseDto> build(HttpStatus status, String code, String message, Map<String, Object> details) {
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        return ResponseEntity.status(status)
                .body(new ErrorResponseDto(code, message, details, traceId));
    }
}
