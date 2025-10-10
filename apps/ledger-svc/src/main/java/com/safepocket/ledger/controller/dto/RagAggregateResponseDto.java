package com.safepocket.ledger.controller.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import java.time.LocalDate;
import java.util.List;

public record RagAggregateResponseDto(
        String granularity,
        @JsonFormat(pattern = "yyyy-MM-dd") LocalDate from,
        @JsonFormat(pattern = "yyyy-MM-dd") LocalDate to,
        List<BucketDto> buckets,
        List<TimelineDto> timeline,
        String traceId,
        String chatId
) {

    public record BucketDto(String key, String label, int count, long sum, long avg) {
    }

    public record TimelineDto(String bucket, int count, long sum) {
    }
}
