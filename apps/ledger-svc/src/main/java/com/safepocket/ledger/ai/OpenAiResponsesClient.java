package com.safepocket.ledger.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.safepocket.ledger.config.SafepocketProperties;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

@Component
public class OpenAiResponsesClient {

    private static final Logger log = LoggerFactory.getLogger(OpenAiResponsesClient.class);
    private static final String GEMINI_DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
    private static final int OPENAI_DEFAULT_MAX_TOKENS = 400;
    private static final int GEMINI_DEFAULT_MAX_TOKENS = 400;
    private static final int GEMINI_MAX_TOKENS = 2048;

    private enum Provider { OPENAI, GEMINI }

    private final SafepocketProperties properties;
    private final RestClient restClient;
    private final ObjectMapper objectMapper;

    public record Message(String role, String content) {}

    public record OpenAiResponsesRequest(String model, List<Message> input, Integer max_output_tokens) {}

    private record GeminiRequestContext(
            List<Message> messages,
            String systemInstruction,
            String endpoint,
            String apiKey,
            String model) {}

    private record GeminiResult(String text, String finishReason, String blockReason, JsonNode raw) {
        boolean hasText() {
            return text != null && !text.isBlank();
        }
    }

    public OpenAiResponsesClient(SafepocketProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        int readTimeoutMs = resolveTimeoutMillis();
        requestFactory.setConnectTimeout(Duration.ofSeconds(12));
        requestFactory.setReadTimeout(Duration.ofMillis(readTimeoutMs));

        this.restClient = RestClient.builder().requestFactory(requestFactory).build();
        log.info("AI HTTP client configured: readTimeoutMs={} (env SAFEPOCKET_AI_TIMEOUT_MS)", readTimeoutMs);
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens) {
        String preferredModel = properties.ai().snapshotOrDefault();
        return generateTextInternal(provider(), inputMessages, maxOutputTokens, preferredModel, true);
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens, String overrideModel) {
        return generateTextInternal(provider(), inputMessages, maxOutputTokens, overrideModel, true);
    }

    public boolean hasCredentials() {
        return resolveApiKey(provider()).isPresent();
    }

    private Optional<String> generateTextInternal(
            Provider provider,
            List<Message> inputMessages,
            Integer maxOutputTokens,
            String model,
            boolean allowFallback) {
        return switch (provider) {
            case GEMINI -> generateGemini(inputMessages, maxOutputTokens, model);
            case OPENAI -> generateOpenAi(inputMessages, maxOutputTokens, model, allowFallback);
        };
    }

    private Optional<String> generateOpenAi(
            List<Message> inputMessages,
            Integer maxOutputTokens,
            String model,
            boolean allowFallback) {
        Optional<String> apiKey = resolveApiKey(Provider.OPENAI);
        if (apiKey.isEmpty()) {
            return Optional.empty();
        }

        int maxTokens = sanitizePositive(maxOutputTokens, OPENAI_DEFAULT_MAX_TOKENS, Integer.MAX_VALUE);
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
                    log.warn("OpenAI Responses model '{}' locked ({}). Retrying with snapshot '{}'.", model, ex.getStatusCode(), snapshot);
                    return generateOpenAi(inputMessages, maxOutputTokens, snapshot, false);
                }
            }
            log.warn("OpenAI Responses call failed (status {}): {}", ex.getStatusCode(), ex.getMessage());
        } catch (Exception ex) {
            log.warn("OpenAI Responses call failed: {}", ex.getMessage());
        }
        return Optional.empty();
    }

    private Optional<String> generateGemini(List<Message> inputMessages, Integer maxOutputTokens, String model) {
        Optional<String> apiKey = resolveApiKey(Provider.GEMINI);
        if (apiKey.isEmpty()) {
            return Optional.empty();
        }

        GeminiRequestContext context = new GeminiRequestContext(
                inputMessages,
                collectSystemInstruction(inputMessages),
                geminiEndpoint(model),
                apiKey.get(),
                model
        );
        int sanitizedTokens = sanitizePositive(maxOutputTokens, GEMINI_DEFAULT_MAX_TOKENS, GEMINI_MAX_TOKENS);
        return generateGemini(context, sanitizedTokens, true);
    }

    private Optional<String> generateGemini(GeminiRequestContext context, int maxTokens, boolean allowExpand) {
        ObjectNode payload = buildGeminiPayload(context, maxTokens, null, false);
        Optional<GeminiResult> initialResult = executeGeminiCall(context, payload);
        if (initialResult.isEmpty()) {
            return Optional.empty();
        }

        GeminiResult result = initialResult.get();
        if (result.hasText()) {
            if (allowExpand && "MAX_TOKENS".equalsIgnoreCase(result.finishReason()) && maxTokens < GEMINI_MAX_TOKENS) {
                Optional<String> continuation = attemptGeminiContinuation(context, result.text(), maxTokens);
                if (continuation.isPresent()) {
                    return continuation;
                }
            }
            return Optional.of(result.text());
        }

        if (allowExpand && "MAX_TOKENS".equalsIgnoreCase(result.finishReason()) && maxTokens < GEMINI_MAX_TOKENS) {
            int bumped = Math.min(Math.max(maxTokens * 2, maxTokens + 400), GEMINI_MAX_TOKENS);
            log.warn("Gemini finishReason=MAX_TOKENS with no text; retrying once with maxOutputTokens={}", bumped);
            return generateGemini(context, bumped, false);
        }

        if (result.blockReason() != null || result.finishReason() != null) {
            log.warn("Gemini returned no text. finishReason={}, blockReason={}", result.finishReason(), result.blockReason());
            String message = "(AI) Response unavailable" +
                    (result.finishReason() != null ? ", finishReason=" + result.finishReason() : "") +
                    (result.blockReason() != null ? ", blockReason=" + result.blockReason() : "") +
                    ". Please rephrase and try again.";
            return Optional.of(message);
        }

        log.warn("Gemini returned no text content. Keys: {}", describeKeys(result.raw(), 8));
        return Optional.empty();
    }

    private Optional<String> attemptGeminiContinuation(GeminiRequestContext context, String partialText, int previousTokens) {
        if (partialText == null || partialText.isBlank()) {
            return Optional.empty();
        }

        int followUpTokens = Math.min(Math.max(previousTokens, 600), GEMINI_MAX_TOKENS);
        ObjectNode continuationPayload = buildGeminiPayload(context, followUpTokens, partialText, true);
        Optional<GeminiResult> continuationResult = executeGeminiCall(context, continuationPayload);
        if (continuationResult.isEmpty()) {
            return Optional.empty();
        }

        GeminiResult result = continuationResult.get();
        if (result.hasText()) {
            String tail = result.text();
            boolean needsSpace = !partialText.endsWith(" ") && !tail.startsWith(" ");
            return Optional.of(partialText + (needsSpace ? " " : "") + tail);
        }

        if (result.blockReason() != null || result.finishReason() != null) {
            log.warn("Gemini continuation returned no text. finishReason={}, blockReason={}", result.finishReason(), result.blockReason());
        }
        return Optional.empty();
    }

    private Optional<GeminiResult> executeGeminiCall(GeminiRequestContext context, ObjectNode payload) {
        try {
            JsonNode response = restClient.post()
                    .uri(context.endpoint())
                    .contentType(MediaType.APPLICATION_JSON)
                    .headers(headers -> headers.set("x-goog-api-key", context.apiKey()))
                    .body(payload)
                    .retrieve()
                    .body(JsonNode.class);
            if (response == null) {
                return Optional.empty();
            }

            String text = extractGeminiText(response);
            String finishReason = readFinishReason(response);
            String blockReason = readBlockReason(response);
            return Optional.of(new GeminiResult(text, finishReason, blockReason, response));
        } catch (RestClientResponseException ex) {
            String body = ex.getResponseBodyAsString();
            log.warn("Gemini call failed (status {}): {}{}", ex.getStatusCode(), ex.getMessage(),
                    body != null && !body.isBlank() ? "; body=" + truncate(body, 400) : "");
        } catch (Exception ex) {
            log.warn("Gemini call failed: {}", ex.getMessage());
        }
        return Optional.empty();
    }

    private ObjectNode buildGeminiPayload(
            GeminiRequestContext context,
            int maxTokens,
            String partialAssistantText,
            boolean addContinuationInstruction) {
        ObjectNode root = objectMapper.createObjectNode();

        if (context.systemInstruction() != null && !context.systemInstruction().isBlank()) {
            ObjectNode si = root.putObject("systemInstruction");
            si.put("role", "system");
            ArrayNode parts = si.putArray("parts");
            parts.addObject().put("text", context.systemInstruction());
        }

        ArrayNode contents = root.putArray("contents");
        appendGeminiMessages(context.messages(), contents);

        if (partialAssistantText != null && !partialAssistantText.isBlank()) {
            ObjectNode partial = contents.addObject();
            partial.put("role", "model");
            partial.putArray("parts").addObject().put("text", partialAssistantText);
        }

        if (addContinuationInstruction) {
            ObjectNode cont = contents.addObject();
            cont.put("role", "user");
            cont.putArray("parts")
                    .addObject()
                    .put("text", "Continue the assistant's previous response. Continue exactly where it was cut off. Do not repeat sentences already given.");
        }

        ObjectNode generationConfig = root.putObject("generationConfig");
        generationConfig.put("maxOutputTokens", maxTokens);
        generationConfig.put("responseMimeType", "text/plain");
        return root;
    }

    private void appendGeminiMessages(List<Message> messages, ArrayNode target) {
        for (Message message : messages) {
            if (message == null || message.role() == null || message.content() == null) {
                continue;
            }
            if ("system".equalsIgnoreCase(message.role())) {
                continue;
            }
            String mappedRole = "assistant".equalsIgnoreCase(message.role()) ? "model" : "user";
            ObjectNode content = target.addObject();
            content.put("role", mappedRole);
            content.putArray("parts").addObject().put("text", message.content());
        }
    }

    private String collectSystemInstruction(List<Message> messages) {
        StringBuilder builder = new StringBuilder();
        for (Message message : messages) {
            if (message != null && "system".equalsIgnoreCase(message.role()) && message.content() != null && !message.content().isBlank()) {
                if (builder.length() > 0) {
                    builder.append("\n\n");
                }
                builder.append(message.content());
            }
        }
        return builder.length() == 0 ? null : builder.toString();
    }

    private String geminiEndpoint(String model) {
        String base = properties.ai().endpoint();
        if (base == null || base.isBlank() || base.contains("api.openai.com")) {
            base = GEMINI_DEFAULT_ENDPOINT;
        }
        if (!base.endsWith("/")) {
            base = base + "/";
        }
        return base + "models/" + model + ":generateContent";
    }

    private Optional<String> resolveApiKey(Provider provider) {
        SafepocketProperties.Ai ai = properties.ai();

        if (provider == Provider.GEMINI) {
            String envKey = System.getenv("GEMINI_API_KEY");
            if (envKey != null && !envKey.isBlank()) {
                return Optional.of(envKey);
            }
            String configured = ai.apiKey();
            if (configured != null && !configured.isBlank()) {
                return Optional.of(configured);
            }
            return Optional.empty();
        }

        String configured = ai.apiKey();
        if (configured != null && !configured.isBlank()) {
            return Optional.of(configured);
        }
        String envKey = System.getenv("OPENAI_API_KEY");
        if (envKey != null && !envKey.isBlank()) {
            return Optional.of(envKey);
        }
        return Optional.empty();
    }

    private Provider provider() {
        return "gemini".equalsIgnoreCase(properties.ai().providerOrDefault()) ? Provider.GEMINI : Provider.OPENAI;
    }

    private int resolveTimeoutMillis() {
        try {
            String env = System.getenv("SAFEPOCKET_AI_TIMEOUT_MS");
            if (env != null && !env.isBlank()) {
                int value = Integer.parseInt(env.trim());
                if (value > 0) {
                    return Math.min(value, 600_000); // cap at 10 minutes
                }
            }
        } catch (Exception ignored) {
        }
        return 90_000;
    }

    private int sanitizePositive(Integer requested, int defaultValue, int maxValue) {
        int value = Optional.ofNullable(requested).filter(v -> v > 0).orElse(defaultValue);
        value = Math.max(1, value);
        return Math.min(value, maxValue);
    }

    private String readFinishReason(JsonNode response) {
        JsonNode candidates = response != null ? response.get("candidates") : null;
        if (candidates != null && candidates.isArray() && candidates.size() > 0) {
            JsonNode finish = candidates.get(0).get("finishReason");
            if (finish != null && finish.isTextual()) {
                return finish.asText();
            }
        }
        return null;
    }

    private String readBlockReason(JsonNode response) {
        JsonNode feedback = response != null ? response.get("promptFeedback") : null;
        if (feedback != null) {
            JsonNode block = feedback.get("blockReason");
            if (block != null && block.isTextual()) {
                return block.asText();
            }
        }
        return null;
    }

    private String truncate(String value, int max) {
        if (value == null || value.length() <= max) {
            return value;
        }
        return value.substring(0, Math.max(0, max)) + "...";
    }

    private String describeKeys(JsonNode node, int maxKeys) {
        if (node == null || !node.isObject()) {
            return "";
        }
        java.util.Iterator<String> names = node.fieldNames();
        java.util.List<String> keys = new java.util.ArrayList<>();
        int count = 0;
        while (names.hasNext() && count < Math.max(1, maxKeys)) {
            keys.add(names.next());
            count++;
        }
        String suffix = names.hasNext() ? ", ..." : "";
        return String.join(", ", keys) + suffix;
    }

    private String extractGeminiText(JsonNode node) {
        if (node == null) {
            return null;
        }

        JsonNode candidates = node.get("candidates");
        if (candidates != null && candidates.isArray()) {
            for (JsonNode candidate : candidates) {
                String candidateText = extractGeminiTextFromCandidate(candidate);
                if (candidateText != null && !candidateText.isBlank()) {
                    return candidateText;
                }
            }
        }

        return extractText(node);
    }

    private String extractGeminiTextFromCandidate(JsonNode candidate) {
        if (candidate == null || candidate.isNull()) {
            return null;
        }

        JsonNode content = candidate.get("content");
        if (content != null && !content.isNull()) {
            JsonNode parts = content.get("parts");
            if (parts != null && parts.isArray()) {
                for (JsonNode part : parts) {
                    String partText = extractGeminiPartText(part);
                    if (partText != null && !partText.isBlank()) {
                        return partText;
                    }
                }
            }
            String fallback = extractText(content);
            if (fallback != null && !fallback.isBlank()) {
                return fallback;
            }
        }

        return extractText(candidate);
    }

    private String extractGeminiPartText(JsonNode part) {
        if (part == null || part.isNull()) {
            return null;
        }

        String text = extractText(part.get("text"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        text = extractText(part.get("functionCall"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        text = extractText(part.get("json"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        text = extractText(part.get("struct"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        text = extractText(part.get("code"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        text = extractText(part.get("data"));
        if (text != null && !text.isBlank()) {
            return text;
        }

        return extractText(part);
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
        JsonNode functionCall = node.get("functionCall");
        if (functionCall != null) {
            String nested = extractText(functionCall);
            if (nested != null && !nested.isBlank()) {
                return nested;
            }
            JsonNode args = functionCall.get("args");
            if (args != null && !args.isNull()) {
                if (args.isTextual()) {
                    return args.asText();
                }
                if (args.isObject() || args.isArray()) {
                    return args.toString();
                }
            }
        }
        JsonNode args = node.get("args");
        if (args != null && !args.isNull()) {
            if (args.isTextual()) {
                return args.asText();
            }
            if (args.isObject() || args.isArray()) {
                return args.toString();
            }
        }
        JsonNode jsonNode = node.get("json");
        if (jsonNode != null && !jsonNode.isNull()) {
            if (jsonNode.isTextual()) {
                return jsonNode.asText();
            }
            return jsonNode.toString();
        }
        JsonNode struct = node.get("struct");
        if (struct != null && !struct.isNull()) {
            return struct.toString();
        }
        JsonNode value = node.get("value");
        if (value != null && value.isTextual()) {
            return value.asText();
        }
        if (node.isObject() && node.size() > 0) {
            JsonNode output = node.get("output");
            if (output != null) {
                String nested = extractText(output);
                if (nested != null && !nested.isBlank()) {
                    return nested;
                }
            }
            return node.toString();
        }
        return null;
    }
}
