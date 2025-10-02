package com.safepocket.ledger.controller;

import com.safepocket.ledger.analytics.AnalyticsService;
import com.safepocket.ledger.controller.dto.AnalyticsSummaryResponseDto;
import com.safepocket.ledger.model.AnalyticsSummary;
import java.time.YearMonth;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/analytics")
public class AnalyticsController {

    private final AnalyticsService analyticsService;

    public AnalyticsController(AnalyticsService analyticsService) {
        this.analyticsService = analyticsService;
    }

    @GetMapping("/summary")
    public ResponseEntity<AnalyticsSummaryResponseDto> getSummary(@RequestParam("month") String month) {
        YearMonth yearMonth = YearMonth.parse(month);
        AnalyticsSummary summary = analyticsService.getSummary(yearMonth);
        AnalyticsSummaryResponseDto response = map(summary);
        return ResponseEntity.ok(response);
    }

    private AnalyticsSummaryResponseDto map(AnalyticsSummary summary) {
        return new AnalyticsSummaryResponseDto(
                summary.month().toString(),
                new AnalyticsSummaryResponseDto.Totals(summary.totals().income(), summary.totals().expense(), summary.totals().net()),
                summary.categories().stream()
                        .map(category -> new AnalyticsSummaryResponseDto.CategoryBreakdown(category.category(), category.amount(), category.percentage()))
                        .toList(),
                summary.merchants().stream()
                        .map(merchant -> new AnalyticsSummaryResponseDto.MerchantBreakdown(merchant.merchant(), merchant.amount(), merchant.transactionCount()))
                        .toList(),
                summary.anomalies().stream()
                        .map(anomaly -> new AnalyticsSummaryResponseDto.AnomalyInsight(
                                anomaly.transactionId(),
                                anomaly.method().name(),
                                anomaly.score(),
                                anomaly.amount(),
                                anomaly.occurredAt(),
                                anomaly.merchantName(),
                                anomaly.commentary()
                        ))
                        .toList(),
                new AnalyticsSummaryResponseDto.AiHighlight(
                        summary.aiHighlight().title(),
                        summary.aiHighlight().summary(),
                        summary.aiHighlight().sentiment().name(),
                        summary.aiHighlight().recommendations()
                ),
                summary.traceId()
        );
    }
}
