package com.safepocket.ledger.controller;

import com.safepocket.ledger.controller.dto.RagAggregateRequestDto;
import com.safepocket.ledger.controller.dto.RagAggregateResponseDto;
import com.safepocket.ledger.controller.dto.RagSearchRequestDto;
import com.safepocket.ledger.controller.dto.RagSearchResponseDto;
import com.safepocket.ledger.controller.dto.RagSummariesResponseDto;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.rag.RagService.AggregateBucket;
import com.safepocket.ledger.rag.RagService.AggregateResponse;
import com.safepocket.ledger.rag.RagService.SearchRequest;
import com.safepocket.ledger.rag.RagService.SearchResponse;
import com.safepocket.ledger.rag.RagService.SummariesResponse;
import com.safepocket.ledger.rag.RagService.TimelinePoint;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import java.time.YearMonth;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/rag")
@Validated
public class RagController {

    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    @PostMapping("/search")
    public ResponseEntity<RagSearchResponseDto> search(
            @Valid @RequestBody RagSearchRequestDto request,
            @RequestHeader(value = "X-Chat-Id", required = false) String chatId
    ) {
        String resolvedChatId = chatId != null && !chatId.isBlank() ? chatId : UUID.randomUUID().toString();
        SearchRequest serviceRequest = new SearchRequest(
                request.q(),
                request.from(),
                request.to(),
                request.categories(),
                request.amountMin(),
                request.amountMax(),
                request.topK()
        );
        SearchResponse result = ragService.search(serviceRequest, resolvedChatId);
        RagSearchResponseDto dto = new RagSearchResponseDto(
                result.rowsCsv(),
                result.dict(),
                new RagSearchResponseDto.StatsDto(result.stats().count(), result.stats().sum(), result.stats().avg()),
                result.traceId(),
                result.chatId()
        );
        return ResponseEntity.ok()
                .header("X-Chat-Id", resolvedChatId)
                .body(dto);
    }

    @GetMapping("/summaries")
    public ResponseEntity<RagSummariesResponseDto> summaries(
            @RequestParam("month") @Pattern(regexp = "^\\d{4}-\\d{2}$") String month
    ) {
        YearMonth ym = YearMonth.parse(month);
        SummariesResponse response = ragService.summaries(ym);
        RagSummariesResponseDto dto = new RagSummariesResponseDto(
                response.month(),
                new RagSummariesResponseDto.TotalsDto(response.totals().income(), response.totals().expense(), response.totals().net()),
                response.categories().stream()
                        .map(cat -> new RagSummariesResponseDto.CategoryDto(cat.code(), cat.label(), cat.count(), cat.sum(), cat.avg()))
                        .toList(),
                response.merchants().stream()
                        .map(m -> new RagSummariesResponseDto.MerchantDto(m.merchantId(), m.label(), m.count(), m.sum()))
                        .toList(),
                response.traceId()
        );
        return ResponseEntity.ok(dto);
    }

    @PostMapping("/aggregate")
    public ResponseEntity<RagAggregateResponseDto> aggregate(
            @Valid @RequestBody RagAggregateRequestDto request,
            @RequestHeader(value = "X-Chat-Id", required = false) String chatId
    ) {
        String resolvedChatId = chatId != null && !chatId.isBlank() ? chatId : UUID.randomUUID().toString();
        AggregateResponse response = ragService.aggregate(
                new RagService.AggregateRequest(request.from(), request.to(), request.granularity(), resolvedChatId));
        List<RagAggregateResponseDto.BucketDto> buckets = response.buckets().stream()
                .map(this::mapBucket)
                .toList();
        List<RagAggregateResponseDto.TimelineDto> timeline = response.timeline().stream()
                .map(this::mapTimeline)
                .toList();
        RagAggregateResponseDto dto = new RagAggregateResponseDto(
                response.granularity(),
                response.from(),
                response.to(),
                buckets,
                timeline,
                response.traceId(),
                response.chatId()
        );
        return ResponseEntity.ok()
                .header("X-Chat-Id", resolvedChatId)
                .body(dto);
    }

    private RagAggregateResponseDto.BucketDto mapBucket(AggregateBucket bucket) {
        return new RagAggregateResponseDto.BucketDto(bucket.key(), bucket.label(), bucket.count(), bucket.sum(), bucket.avg());
    }

    private RagAggregateResponseDto.TimelineDto mapTimeline(TimelinePoint point) {
        return new RagAggregateResponseDto.TimelineDto(point.bucket(), point.count(), point.sum());
    }
}
