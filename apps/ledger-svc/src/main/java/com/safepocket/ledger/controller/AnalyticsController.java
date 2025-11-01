package com.safepocket.ledger.controller;

import com.safepocket.ledger.analytics.AnalyticsService;
import com.safepocket.ledger.controller.dto.AnalyticsSummaryResponseDto;
import com.safepocket.ledger.model.AnalyticsSummary;
import java.math.BigDecimal;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
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
        public ResponseEntity<AnalyticsSummaryResponseDto> getSummary(
                        @RequestParam("month") String month,
                        @RequestParam(value = "generateAi", required = false, defaultValue = "false") boolean generateAi
        ) {
        YearMonth yearMonth = YearMonth.parse(month);
                AnalyticsSummary summary = analyticsService.getSummary(yearMonth, generateAi);
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
                                anomaly.amount(),
                                Optional.ofNullable(anomaly.deltaAmount()).orElse(BigDecimal.ZERO),
                                Optional.ofNullable(anomaly.budgetImpactPercent()).orElse(BigDecimal.ZERO),
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
                mapLatestHighlight(summary.latestHighlight()),
                mapSafeToSpend(summary.safeToSpend()),
                summary.traceId()
        );
    }

    private AnalyticsSummaryResponseDto.HighlightSnapshot mapLatestHighlight(AnalyticsSummary.HighlightSnapshot snapshot) {
        if (snapshot == null) {
            return null;
        }
        AnalyticsSummaryResponseDto.AiHighlight highlight = new AnalyticsSummaryResponseDto.AiHighlight(
                snapshot.highlight().title(),
                snapshot.highlight().summary(),
                snapshot.highlight().sentiment().name(),
                snapshot.highlight().recommendations()
        );
        return new AnalyticsSummaryResponseDto.HighlightSnapshot(snapshot.month().toString(), highlight);
    }

    private AnalyticsSummaryResponseDto.SafeToSpend mapSafeToSpend(AnalyticsSummary.SafeToSpend safeToSpend) {
        if (safeToSpend == null) {
            return new AnalyticsSummaryResponseDto.SafeToSpend(
                    null,
                    null,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    0,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    false,
                    List.of()
            );
        }
        return new AnalyticsSummaryResponseDto.SafeToSpend(
                safeToSpend.cycleStart(),
                safeToSpend.cycleEnd(),
                safeToSpend.safeToSpendToday(),
                safeToSpend.hardCap(),
                safeToSpend.dailyBase(),
                safeToSpend.dailyAdjusted(),
                safeToSpend.rollToday(),
                safeToSpend.paceRatio(),
                safeToSpend.adjustmentFactor(),
                safeToSpend.daysRemaining(),
                safeToSpend.variableBudget(),
                safeToSpend.variableSpent(),
                safeToSpend.remainingVariableBudget(),
                safeToSpend.danger(),
                safeToSpend.notes()
        );
    }
}
