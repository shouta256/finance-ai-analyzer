package com.safepocket.ledger.rag;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Tracks which transactions have already been sent to a chat session so that follow-up
 * questions only return deltas. Backed by an in-memory cache with TTL.
 */
import org.springframework.stereotype.Component;

@Component
public class ChatSessionDiffTracker {

    private final ConcurrentMap<String, SessionState> state = new ConcurrentHashMap<>();
    private final Duration ttl;

    public ChatSessionDiffTracker() {
        this(Duration.ofHours(4));
    }

    public ChatSessionDiffTracker(Duration ttl) {
        this.ttl = Objects.requireNonNull(ttl);
    }

    public List<String> filterNew(String chatId, List<String> txCodes) {
        if (txCodes.isEmpty()) {
            return Collections.emptyList();
        }
        SessionState session = state.compute(chatId, (key, existing) -> {
            if (existing == null || existing.isExpired(ttl)) {
                return new SessionState();
            }
            existing.touch();
            return existing;
        });
        List<String> unseen = new ArrayList<>(txCodes.size());
        for (String code : txCodes) {
            if (session.markIfNew(code)) {
                unseen.add(code);
            }
        }
        session.touch();
        return unseen;
    }

    public int incrementHits(String chatId) {
        SessionState session = state.compute(chatId, (key, existing) -> {
            if (existing == null || existing.isExpired(ttl)) {
                return new SessionState();
            }
            existing.touch();
            return existing;
        });
        return session.incrementHits();
    }

    record Snapshot(int hitCount, Set<String> sentCodes) {
    }

    private static final class SessionState {
        private final Set<String> sent = ConcurrentHashMap.newKeySet();
        private final AtomicInteger hitCount = new AtomicInteger();
        private volatile Instant lastSeen = Instant.now();

        boolean markIfNew(String code) {
            return sent.add(code);
        }

        int incrementHits() {
            touch();
            return hitCount.incrementAndGet();
        }

        void touch() {
            lastSeen = Instant.now();
        }

        boolean isExpired(Duration ttl) {
            return lastSeen.plus(ttl).isBefore(Instant.now());
        }
    }
}
