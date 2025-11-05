package com.safepocket.ledger.controller.dto;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

public record TransactionsListResponseDto(
        PeriodDto period,
        AggregatesDto aggregates,
        Integer page,
        Integer pageSize,
        Long total,
        List<TransactionResponseDto> transactions,
        String traceId
) {

    public record PeriodDto(String month, LocalDate from, LocalDate to) {
    }

    public record AggregatesDto(
            BigDecimal incomeTotal,
            BigDecimal expenseTotal,
            BigDecimal netTotal,
            Map<String, BigDecimal> monthNet,
            Map<String, BigDecimal> dayNet,
            List<SeriesPointDto> monthSeries,
            List<SeriesPointDto> daySeries,
            List<SeriesPointDto> trendSeries,
            String trendGranularity,
            Map<String, BigDecimal> categoryTotals,
            Integer count
    ) {
        public record SeriesPointDto(String period, BigDecimal net) {
        }
    }
}
