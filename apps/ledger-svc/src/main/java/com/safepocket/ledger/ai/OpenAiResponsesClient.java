package com.safepocket.ledger.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.safepocket.ledger.config.SafepocketProperties;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

@Component
public class OpenAiResponsesClient {

    private static final Logger log = LoggerFactory.getLogger(OpenAiResponsesClient.class);

    private final SafepocketProperties properties;
    private final RestClient restClient;
    private final ObjectMapper objectMapper;

    public record Message(String role, String content) {}

    public record OpenAiResponsesRequest(String model, List<Message> input, Integer max_output_tokens) {}

    public OpenAiResponsesClient(SafepocketProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.restClient = RestClient.create();
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens) {
        return generateText(inputMessages, maxOutputTokens, properties.ai().model(), true);
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens, String overrideModel) {
        return generateText(inputMessages, maxOutputTokens, overrideModel, true);
    }

    public boolean hasCredentials() {
        return resolveApiKey().isPresent();
    }

    private Optional<String> generateText(
            List<Message> inputMessages, Integer maxOutputTokens, String model, boolean allowFallback) {
        Optional<String> apiKey = resolveApiKey();
        if (apiKey.isEmpty()) {
            return Optional.empty();
        }

        Integer maxTokens = Optional.ofNullable(maxOutputTokens).filter(v -> v > 0).orElse(400);
        OpenAiResponsesRequest requestBody = new OpenAiResponsesRequest(model, inputMessages, maxTokens);

        try {
            JsonNode response = restClient.post()
                    .uri(properties.ai().endpoint())
                    .contentType(MediaType.APPLICATION_JSON)
                    .headers(headers -> headers.setBearerAuth(apiKey.get()))
                    .body(requestBody)
                    .retrieve()
                    .body(JsonNode.class);
            if (response == null) {
                return Optional.empty();
            }

            JsonNode output = response.get("output");
            String text = extractText(output);
            if (text == null || text.isBlank()) {
                text = extractText(response);
            }
            return Optional.ofNullable(text).filter(s -> !s.isBlank());
        } catch (RestClientResponseException ex) {
            if (allowFallback && ex.getStatusCode().value() == 421) {
                String snapshot = properties.ai().snapshotOrDefault();
                if (snapshot != null && !snapshot.isBlank() && !Objects.equals(snapshot, model)) {
                    log.warn("OpenAI Responses model '{}' locked ({}). Retrying with snapshot '{}'.",
                            model, ex.getStatusCode(), snapshot);
                    return generateText(inputMessages, maxOutputTokens, snapshot, false);
                }
            }
            log.warn("OpenAI Responses call failed (status {}): {}", ex.getStatusCode(), ex.getMessage());
        } catch (Exception ex) {
            log.warn("OpenAI Responses call failed: {}", ex.getMessage());
        }
        return Optional.empty();
    }

    private Optional<String> resolveApiKey() {
        String configured = properties.ai().apiKey();
        if (configured != null && !configured.isBlank()) {
            return Optional.of(configured);
        }
        String env = System.getenv("OPENAI_API_KEY");
        if (env != null && !env.isBlank()) {
            return Optional.of(env);
        }
        return Optional.empty();
    }

    private String extractText(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isTextual()) {
            return node.asText();
        }
        if (node.isArray()) {
            for (JsonNode item : node) {
                String nested = extractText(item);
                if (nested != null && !nested.isBlank()) {
                    return nested;
                }
            }
        }
        JsonNode content = node.get("content");
        if (content != null) {
            String nested = extractText(content);
            if (nested != null && !nested.isBlank()) {
                return nested;
            }
        }
        JsonNode text = node.get("text");
        if (text != null) {
            String nested = extractText(text);
            if (nested != null && !nested.isBlank()) {
                return nested;
            }
        }
        JsonNode value = node.get("value");
        if (value != null && value.isTextual()) {
            return value.asText();
        }
        return null;
    }
}
