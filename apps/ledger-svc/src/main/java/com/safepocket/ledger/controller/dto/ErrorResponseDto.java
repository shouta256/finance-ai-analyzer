package com.safepocket.ledger.controller.dto;

import java.util.Map;

public record ErrorResponseDto(String code, String message, Map<String, Object> details, String traceId) {
}
