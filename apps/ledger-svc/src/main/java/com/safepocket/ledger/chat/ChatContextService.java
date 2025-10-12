package com.safepocket.ledger.chat;

import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class ChatContextService {

    public ChatContextService() {}

    public String buildContext(UUID userId, UUID conversationId, String latestUserMessage) {
        // RAG has been removed. For now, we return an empty context string.
        return "";
    }
}
