package com.safepocket.ledger.ai;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.config.SafepocketProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

class OpenAiResponsesClientTest {

    @Test
    void geminiModelCandidatesKeepOnlyConfiguredModel() {
        OpenAiResponsesClient client = new OpenAiResponsesClient(properties("gemini-2.5-flash"), new ObjectMapper());

        List<String> candidates = client.geminiModelCandidates("gemini-2.5-flash");

        assertThat(candidates).containsExactly("gemini-2.5-flash");
    }

    private SafepocketProperties properties(String model) {
        return new SafepocketProperties(
                new SafepocketProperties.Cognito("https://example.com", "aud", false, "domain", "client", null, null, null, null),
                new SafepocketProperties.Plaid("id", "secret", null, "https://sandbox.plaid.com", "sandbox", null, null),
                new SafepocketProperties.Ai("gemini", model, "https://generativelanguage.googleapis.com/v1beta", "test-key", null),
                new SafepocketProperties.Security("12345678901234567890123456789012", null),
                new SafepocketProperties.Rag("pgvector", "text-embedding-3-small", 20, 8, false)
        );
    }
}
