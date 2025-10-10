package com.safepocket.ledger.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ChatMessageRetentionManagerTest {

    @Mock
    private ChatMessageRepository repository;

    private ChatMessageRetentionManager manager;
    private final Clock clock = Clock.fixed(Instant.parse("2024-06-01T12:00:00Z"), ZoneOffset.UTC);

    @BeforeEach
    void setUp() {
        manager = new ChatMessageRetentionManager(repository, 30, clock);
    }

    @Test
    void purgeExpiredMessagesUsesCutoff() {
        when(repository.deleteOlderThan(Instant.parse("2024-05-02T12:00:00Z"))).thenReturn(3);

        manager.purgeExpiredMessagesNow();

        ArgumentCaptor<Instant> captor = ArgumentCaptor.forClass(Instant.class);
        verify(repository).deleteOlderThan(captor.capture());
        assertThat(captor.getValue()).isEqualTo(Instant.parse("2024-05-02T12:00:00Z"));
    }

    @Test
    void currentCutoffMatchesRetentionWindow() {
        Instant cutoff = manager.currentCutoff();
        assertThat(cutoff).isEqualTo(Instant.parse("2024-05-02T12:00:00Z"));
    }

    @Test
    void rejectsInvalidRetention() {
        assertThatThrownBy(() -> new ChatMessageRetentionManager(repository, 0, clock))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("retentionDays");
    }
}
