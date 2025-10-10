package com.safepocket.ledger.chat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class ChatMessageRetentionManager {

    private static final Logger log = LoggerFactory.getLogger(ChatMessageRetentionManager.class);

    private final ChatMessageRepository repository;
    private final Duration retention;
    private final Clock clock;

    @Autowired
    public ChatMessageRetentionManager(ChatMessageRepository repository,
                                       @Value("${safepocket.chat.retention-days:30}") int retentionDays) {
        this(repository, retentionDays, Clock.systemUTC());
    }

    ChatMessageRetentionManager(ChatMessageRepository repository, int retentionDays, Clock clock) {
        if (retentionDays <= 0) {
            throw new IllegalArgumentException("retentionDays must be positive");
        }
        this.repository = repository;
        this.retention = Duration.ofDays(retentionDays);
        this.clock = clock;
    }

    @Scheduled(cron = "${safepocket.chat.cleanup-cron:0 30 3 * * *}")
    @Transactional
    public void purgeExpiredMessagesOnSchedule() {
        purgeExpiredMessages("scheduled");
    }

    @Transactional
    public void purgeExpiredMessagesNow() {
        purgeExpiredMessages("inline");
    }

    private void purgeExpiredMessages(String source) {
        Instant cutoff = currentCutoff();
        int removed = repository.deleteOlderThan(cutoff);
        if (removed > 0) {
            log.info("Chat message retention ({}): {} messages removed older than {}", source, removed, cutoff);
        } else {
            log.debug("Chat message retention ({}): no messages older than {}", source, cutoff);
        }
    }

    Duration retentionPeriod() {
        return retention;
    }

    Instant currentCutoff() {
        return clock.instant().minus(retention);
    }
}
