package com.safepocket.ledger.rag;

import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class RagAuditLogger {

    private static final Logger log = LoggerFactory.getLogger(RagAuditLogger.class);

    private final ConcurrentMap<String, AtomicInteger> chatHitCounts = new ConcurrentHashMap<>();

    public int incrementHits(String chatId) {
        return chatHitCounts.computeIfAbsent(chatId, k -> new AtomicInteger()).incrementAndGet();
    }

    public void record(String endpoint, UUID userId, String chatId, int rows, int tokensEstimate) {
        int hits = incrementHits(chatId);
        log.info("rag_audit endpoint={} userId={} chatId={} hits={} rows={} tokens={}",
                endpoint, userId, chatId, hits, rows, tokensEstimate);
    }
}
