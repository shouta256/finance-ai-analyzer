package com.safepocket.ledger.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

class PostgreSQLTransactionRepositoryTest {

    @Mock
    private JpaTransactionRepository jpaTransactionRepository;

    @Mock
    private JpaMerchantRepository jpaMerchantRepository;

    private PostgreSQLTransactionRepository repository;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        repository = new PostgreSQLTransactionRepository(jpaTransactionRepository, jpaMerchantRepository);
    }

    @Test
    void loadAggregatesUnwrapsNestedProjectionRows() {
        UUID userId = UUID.randomUUID();
        Instant from = Instant.parse("2026-04-01T00:00:00Z");
        Instant to = Instant.parse("2026-05-01T00:00:00Z");
        Timestamp bucketTs = Timestamp.from(Instant.parse("2026-04-01T00:00:00Z"));
        Timestamp minTs = Timestamp.from(Instant.parse("2026-04-03T00:00:00Z"));
        Timestamp maxTs = Timestamp.from(Instant.parse("2026-04-20T00:00:00Z"));

        when(jpaTransactionRepository.totalsForRange(userId, from, to, null))
                .thenReturn(new Object[] {
                        new Object[] {
                                new BigDecimal("4200.00"),
                                new BigDecimal("-181.05"),
                                2L,
                                minTs,
                                maxTs
                        }
                });
        when(jpaTransactionRepository.monthNetByRange(userId, from, to, null))
                .thenReturn(List.<Object[]>of(new Object[] { new Object[] { bucketTs, new BigDecimal("4018.95") } }));
        when(jpaTransactionRepository.dayNetByRange(userId, from, to, null))
                .thenReturn(List.<Object[]>of(new Object[] { new Object[] { bucketTs, new BigDecimal("4018.95") } }));
        when(jpaTransactionRepository.expenseByCategory(userId, from, to, null))
                .thenReturn(List.<Object[]>of(new Object[] { new Object[] { "Dining", new BigDecimal("-181.05") } }));

        TransactionRepository.AggregateSnapshot snapshot =
                repository.loadAggregates(userId, from, to, Optional.empty());

        assertThat(snapshot.incomeTotal()).isEqualByComparingTo("4200.00");
        assertThat(snapshot.expenseTotal()).isEqualByComparingTo("-181.05");
        assertThat(snapshot.count()).isEqualTo(2L);
        assertThat(snapshot.minOccurredAt()).isEqualTo(minTs.toInstant());
        assertThat(snapshot.maxOccurredAt()).isEqualTo(maxTs.toInstant());
        assertThat(snapshot.monthBuckets())
                .containsExactly(new TransactionRepository.AggregateBucket("2026-04", new BigDecimal("4018.95")));
        assertThat(snapshot.dayBuckets())
                .containsExactly(new TransactionRepository.AggregateBucket("2026-04-01", new BigDecimal("4018.95")));
        assertThat(snapshot.categoryBuckets())
                .containsExactly(new TransactionRepository.AggregateBucket("Dining", new BigDecimal("-181.05")));
    }
}
