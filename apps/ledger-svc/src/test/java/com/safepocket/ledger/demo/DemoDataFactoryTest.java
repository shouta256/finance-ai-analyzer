package com.safepocket.ledger.demo;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.YearMonth;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

class DemoDataFactoryTest {

    @Test
    void generatesRelativeDatasetWithoutFutureCurrentMonthTransactions() {
        DemoDataFactory factory = new DemoDataFactory(
                new ObjectMapper(),
                new ClassPathResource("demo/demo-profile.json"),
                Clock.fixed(Instant.parse("2026-04-06T12:00:00Z"), ZoneOffset.UTC)
        );

        UUID userId = UUID.fromString("0f08d2b9-28b3-4b28-bd33-41a36161e9ab");
        var accounts = factory.buildAccounts(userId);
        var transactions = factory.buildTransactions(userId, factory.buildAccountIdIndex(userId));

        assertThat(accounts).hasSize(3);
        assertThat(transactions).hasSizeGreaterThan(80);
        assertThat(transactions)
                .allSatisfy(tx -> assertThat(tx.occurredAt()).isBeforeOrEqualTo(Instant.parse("2026-04-06T00:00:00Z")));
        assertThat(transactions)
                .anySatisfy(tx -> assertThat(tx.merchantName()).isEqualTo("Blue Bottle Coffee"));
        assertThat(transactions)
                .anySatisfy(tx -> assertThat(tx.merchantName()).isEqualTo("Emergency Hospital Bill"));

        YearMonth currentMonth = YearMonth.of(2026, 4);
        YearMonth previousMonth = currentMonth.minusMonths(1);
        assertThat(transactions)
                .anySatisfy(tx -> assertThat(YearMonth.from(tx.occurredAt().atZone(ZoneOffset.UTC))).isEqualTo(currentMonth));
        assertThat(transactions)
                .anySatisfy(tx -> assertThat(YearMonth.from(tx.occurredAt().atZone(ZoneOffset.UTC))).isEqualTo(previousMonth));
    }
}
