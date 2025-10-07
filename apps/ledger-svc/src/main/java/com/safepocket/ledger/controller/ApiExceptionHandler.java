package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.ErrorResponseDto;
import com.safepocket.ledger.security.RequestContextHolder;
import jakarta.validation.ConstraintViolationException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

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
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Unexpected error", Map.of("reason", ex.getMessage()));
    }

    @ExceptionHandler(CannotGetJdbcConnectionException.class)
    public ResponseEntity<ErrorResponseDto> handleJdbc(CannotGetJdbcConnectionException ex) {
        return build(HttpStatus.SERVICE_UNAVAILABLE, "DB_UNAVAILABLE", "Database temporarily unavailable", Map.of(
                "reason", ex.getMostSpecificCause() != null ? ex.getMostSpecificCause().getMessage() : ex.getMessage()
        ));
    }

    private ResponseEntity<ErrorResponseDto> build(HttpStatus status, String code, String message, Map<String, Object> details) {
        String traceId = RequestContextHolder.get().map(RequestContextHolder.RequestContext::traceId).orElse(null);
        return ResponseEntity.status(status)
                .body(new ErrorResponseDto(code, message, details, traceId));
    }
}
