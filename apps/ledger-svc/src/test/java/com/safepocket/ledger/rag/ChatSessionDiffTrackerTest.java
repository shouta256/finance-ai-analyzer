package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

class ChatSessionDiffTrackerTest {

    @Test
    void firstInvocationReturnsAll() {
        ChatSessionDiffTracker tracker = new ChatSessionDiffTracker();
        List<String> unseen = tracker.filterNew("chat-1", List.of("a", "b", "c"));
        assertThat(unseen).containsExactly("a", "b", "c");
    }

    @Test
    void subsequentInvocationSkipsSeen() {
        ChatSessionDiffTracker tracker = new ChatSessionDiffTracker(Duration.ofMinutes(5));
        tracker.filterNew("chat-1", List.of("a", "b"));
        List<String> unseen = tracker.filterNew("chat-1", List.of("a", "b", "c"));
        assertThat(unseen).containsExactly("c");
        int hits = tracker.incrementHits("chat-1");
        assertThat(hits).isEqualTo(1);
    }
}
