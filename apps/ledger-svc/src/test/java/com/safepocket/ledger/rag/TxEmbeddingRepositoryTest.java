package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import java.sql.SQLException;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

@ExtendWith(MockitoExtension.class)
class TxEmbeddingRepositoryTest {

    @Mock
    NamedParameterJdbcTemplate jdbcTemplate;

    @Mock
    EmbeddingService embeddingService;

    TxEmbeddingRepository repository;

    @BeforeEach
    void setUp() {
        repository = new TxEmbeddingRepository(jdbcTemplate, embeddingService);
    }

    @Test
    void findNearestReturnsEmptyWhenEmbeddingsTableIsMissing() {
        BadSqlGrammarException missingTable = new BadSqlGrammarException(
                "findNearest",
                "select * from tx_embeddings",
                new SQLException("ERROR: relation \"tx_embeddings\" does not exist", "42P01")
        );
        when(jdbcTemplate.query(anyString(), any(MapSqlParameterSource.class), any(RowMapper.class)))
                .thenThrow(missingTable);

        List<TxEmbeddingRepository.EmbeddingMatch> result = repository.findNearest(
                UUID.randomUUID(),
                new float[] {0.1f},
                LocalDate.now().minusDays(30),
                LocalDate.now(),
                null,
                null,
                null,
                20
        );

        assertThat(result).isEmpty();
    }

    @Test
    void upsertBatchBecomesNoOpWhenEmbeddingsTableIsMissing() {
        BadSqlGrammarException missingTable = new BadSqlGrammarException(
                "upsertBatch",
                "insert into tx_embeddings",
                new SQLException("ERROR: relation \"tx_embeddings\" does not exist", "42P01")
        );
        when(embeddingService.formatForSql(any())).thenReturn("[0.1]");
        when(jdbcTemplate.batchUpdate(anyString(), any(MapSqlParameterSource[].class)))
                .thenThrow(missingTable);

        assertThatCode(() -> repository.upsertBatch(List.of(
                new TxEmbeddingRepository.EmbeddingRecord(
                        UUID.randomUUID(),
                        UUID.randomUUID(),
                        java.time.YearMonth.now(),
                        "Dining",
                        1200,
                        UUID.randomUUID(),
                        "starbucks",
                        new float[] {0.1f}
                )
        ))).doesNotThrowAnyException();
    }
}
