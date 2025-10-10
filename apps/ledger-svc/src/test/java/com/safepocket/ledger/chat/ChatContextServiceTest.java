package com.safepocket.ledger.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.rag.RagService;
import com.safepocket.ledger.rag.RagService.AggregateBucket;
import com.safepocket.ledger.rag.RagService.AggregateRequest;
import com.safepocket.ledger.rag.RagService.AggregateResponse;
import com.safepocket.ledger.rag.RagService.CategoryBreakdown;
import com.safepocket.ledger.rag.RagService.MerchantBreakdown;
import com.safepocket.ledger.rag.RagService.SearchResponse;
import com.safepocket.ledger.rag.RagService.Stats;
import com.safepocket.ledger.rag.RagService.SummariesResponse;
import com.safepocket.ledger.rag.RagService.TimelinePoint;
import com.safepocket.ledger.rag.RagService.Totals;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

class ChatContextServiceTest {

    private final RagService ragService = Mockito.mock(RagService.class);
    private ChatContextService chatContextService;

    @BeforeEach
    void setUp() {
        chatContextService = new ChatContextService(ragService, new ObjectMapper());
        Totals totals = new Totals(10_000L, -5_000L, 5_000L);
        when(ragService.summariesForUser(any(UUID.class), any(YearMonth.class))).thenAnswer(invocation -> {
            YearMonth ym = invocation.getArgument(1);
            return new SummariesResponse(
                    ym.toString(),
                    totals,
                    List.of(new CategoryBreakdown("eo", "EatingOut", 2, -1_200L, -600L)),
                    List.of(new MerchantBreakdown("m1", "Starbucks", 2, -1_200L)),
                    "trace-summary"
            );
        });
    }

    @Test
    void buildContextUsesSummariesOnlyForGeneralQuestion() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID conversationId = UUID.randomUUID();

        String context = chatContextService.buildContext(userId, conversationId, "今月の状況を教えて");
        assertThat(context).isNotBlank();
        assertThat(context).contains("months");
        assertThat(context).doesNotContain("transactionsCsv");
        assertThat(context).doesNotContain("\"aggregate\"");
        verify(ragService).summariesForUser(any(UUID.class), any(YearMonth.class));
        verify(ragService, never()).searchForUser(any(), any(), any());
        verify(ragService, never()).aggregateForUser(any(), any(AggregateRequest.class));
    }

    @Test
    void buildContextTriggersSearchWhenDetailsRequested() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID conversationId = UUID.randomUUID();
        SearchResponse searchResponse = new SearchResponse(
                "t1,250801,m1,680,eo",
                Map.of("merchants", Map.of("m1", "Starbucks"), "categories", Map.of("eo", "EatingOut")),
                new Stats(1, 680, 680),
                "trace-search",
                conversationId.toString()
        );
        when(ragService.searchForUser(any(UUID.class), any(), any())).thenReturn(searchResponse);

        String context = chatContextService.buildContext(userId, conversationId, "スタバの明細を見せて");
        assertThat(context).contains("transactionsCsv");
        verify(ragService).searchForUser(any(), any(), Mockito.eq(conversationId.toString()));
    }

    @Test
    void buildContextTriggersAggregateForTrendQuestions() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID conversationId = UUID.randomUUID();
        AggregateResponse aggregateResponse = new AggregateResponse(
                "month",
                LocalDate.of(2025, 8, 1),
                LocalDate.of(2025, 8, 31),
                List.of(new AggregateBucket("2025-08", "2025-08", 3, -1500, -500)),
                List.of(new TimelinePoint("2025-08", 3, -1500)),
                "trace-agg",
                conversationId.toString()
        );
        when(ragService.aggregateForUser(any(UUID.class), any(AggregateRequest.class))).thenReturn(aggregateResponse);

        String context = chatContextService.buildContext(userId, conversationId, "カテゴリ別の平均推移を教えて");
        assertThat(context).isNotBlank();
        assertThat(context.contains("\"aggregate\"")).as("context=%s", context).isTrue();

        ArgumentCaptor<AggregateRequest> captor = ArgumentCaptor.forClass(AggregateRequest.class);
        verify(ragService).summariesForUser(any(UUID.class), any(YearMonth.class));
        verify(ragService).aggregateForUser(any(), captor.capture());
        assertThat(captor.getValue().granularity()).isEqualTo("month");
    }

    @Test
    void buildContextTriggersAggregateForTopSpendingQuestion() throws Exception {
        UUID userId = UUID.randomUUID();
        UUID conversationId = UUID.randomUUID();
        AggregateResponse aggregateResponse = new AggregateResponse(
                "category",
                LocalDate.of(2025, 8, 1),
                LocalDate.of(2025, 8, 31),
                List.of(new AggregateBucket("EatingOut", "EatingOut", 4, -2000, -500)),
                List.of(new TimelinePoint("2025-08", 4, -2000)),
                "trace-agg",
                conversationId.toString()
        );
        when(ragService.aggregateForUser(any(UUID.class), any(AggregateRequest.class))).thenReturn(aggregateResponse);

        String context = chatContextService.buildContext(userId, conversationId, "一番お金を使っているカテゴリは何？");
        assertThat(context).isNotBlank();
        assertThat(context).contains("\"aggregate\"");

        ArgumentCaptor<AggregateRequest> captor = ArgumentCaptor.forClass(AggregateRequest.class);
        verify(ragService).aggregateForUser(any(), captor.capture());
        assertThat(captor.getValue().granularity()).isEqualTo("category");
    }
}
