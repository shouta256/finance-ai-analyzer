package com.safepocket.ledger.demo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.entity.AccountEntity;
import com.safepocket.ledger.model.Transaction;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Component;

@Component
public class DemoDataFactory {

    private final DemoProfile profile;
    private final Clock clock;

    @Autowired
    public DemoDataFactory(
            ObjectMapper objectMapper,
            @Value("classpath:demo/demo-profile.json") Resource profileResource
    ) {
        this(objectMapper, profileResource, Clock.systemUTC());
    }

    public DemoDataFactory(ObjectMapper objectMapper, Resource profileResource, Clock clock) {
        this.profile = loadProfile(objectMapper, profileResource);
        this.clock = clock;
    }

    public List<AccountEntity> buildAccounts(UUID userId) {
        Instant createdAt = Instant.now(clock);
        return profile.accounts().stream()
                .map(account -> new AccountEntity(
                        accountIdForUser(userId, account.key()),
                        userId,
                        account.name(),
                        account.institution(),
                        createdAt
                ))
                .toList();
    }

    public Map<String, UUID> buildAccountIdIndex(UUID userId) {
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (DemoAccount account : profile.accounts()) {
            ids.put(account.key(), accountIdForUser(userId, account.key()));
        }
        return ids;
    }

    public List<Transaction> buildTransactions(UUID userId, Map<String, UUID> accountIds) {
        LocalDate today = LocalDate.now(clock);
        YearMonth currentMonth = YearMonth.from(today);
        List<Transaction> transactions = new ArrayList<>();
        for (DemoTransactionTemplate template : profile.transactions()) {
            UUID accountId = accountIds.get(template.accountKey());
            if (accountId == null) {
                continue;
            }
            for (Integer offsetValue : template.monthOffsets()) {
                if (offsetValue == null) {
                    continue;
                }
                int monthOffset = Math.max(0, offsetValue);
                YearMonth month = currentMonth.minusMonths(monthOffset);
                for (Integer dayValue : template.days()) {
                    if (dayValue == null) {
                        continue;
                    }
                    int day = clampDay(month, dayValue);
                    if (monthOffset == 0 && day > today.getDayOfMonth()) {
                        continue;
                    }
                    Instant occurredAt = month.atDay(day).atStartOfDay(ZoneOffset.UTC).toInstant();
                    boolean pending = template.pendingForCurrentMonth() && monthOffset == 0;
                    transactions.add(new Transaction(
                            deterministicUuid("demo:tx:%s:%s:%s".formatted(userId, template.key(), occurredAt)),
                            userId,
                            accountId,
                            template.merchantName(),
                            template.amount(),
                            "USD",
                            occurredAt,
                            occurredAt.minus(30, ChronoUnit.MINUTES),
                            pending,
                            template.category(),
                            template.description(),
                            java.util.Optional.empty(),
                            java.util.Optional.empty()
                    ));
                }
            }
        }
        return transactions;
    }

    public UUID accountIdForUser(UUID userId, String accountKey) {
        return deterministicUuid("demo:account:%s:%s".formatted(userId, accountKey));
    }

    private DemoProfile loadProfile(ObjectMapper objectMapper, Resource profileResource) {
        try (var inputStream = profileResource.getInputStream()) {
            DemoProfile loaded = objectMapper.readValue(inputStream, DemoProfile.class);
            return loaded.normalize();
        } catch (IOException e) {
            throw new IllegalStateException("Failed to load shared demo profile", e);
        }
    }

    private int clampDay(YearMonth month, int requestedDay) {
        return Math.max(1, Math.min(requestedDay, month.lengthOfMonth()));
    }

    private UUID deterministicUuid(String value) {
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8));
    }

    public record DemoUser(UUID id, String email, String fullName) {
    }

    public record DemoAccount(String key, String name, String institution, BigDecimal balance, String currency) {
        DemoAccount normalize() {
            return new DemoAccount(
                    key,
                    name,
                    institution,
                    balance == null ? BigDecimal.ZERO : balance,
                    currency == null || currency.isBlank() ? "USD" : currency
            );
        }
    }

    public record DemoTransactionTemplate(
            String key,
            String accountKey,
            String merchantName,
            BigDecimal amount,
            String category,
            String description,
            Boolean pendingCurrentMonth,
            List<Integer> monthOffsets,
            List<Integer> days
    ) {
        DemoTransactionTemplate normalize() {
            return new DemoTransactionTemplate(
                    key,
                    accountKey,
                    merchantName,
                    amount == null ? BigDecimal.ZERO : amount,
                    category,
                    description,
                    Boolean.TRUE.equals(pendingCurrentMonth),
                    monthOffsets == null ? List.of() : List.copyOf(monthOffsets),
                    days == null ? List.of() : List.copyOf(days)
            );
        }

        public boolean pendingForCurrentMonth() {
            return Boolean.TRUE.equals(pendingCurrentMonth);
        }
    }

    public record DemoProfile(DemoUser user, List<DemoAccount> accounts, List<DemoTransactionTemplate> transactions) {
        DemoProfile normalize() {
            return new DemoProfile(
                    user,
                    accounts == null ? List.of() : accounts.stream().map(DemoAccount::normalize).toList(),
                    transactions == null ? List.of() : transactions.stream().map(DemoTransactionTemplate::normalize).toList()
            );
        }
    }
}
