package com.safepocket.ledger.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import java.time.Duration;

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
        SimpleClientHttpRequestFactory rf = new SimpleClientHttpRequestFactory();
        int readMs = resolveTimeoutMillis();
        rf.setConnectTimeout(Duration.ofSeconds(12));
        rf.setReadTimeout(Duration.ofMillis(readMs));
        this.restClient = RestClient.builder().requestFactory(rf).build();
        log.info("AI HTTP client configured: readTimeoutMs={} (env SAFEPOCKET_AI_TIMEOUT_MS)", readMs);
    }

    private int resolveTimeoutMillis() {
        try {
            String env = System.getenv("SAFEPOCKET_AI_TIMEOUT_MS");
            if (env != null && !env.isBlank()) {
                int v = Integer.parseInt(env.trim());
                if (v > 0) {
                    int cap = 600_000; // cap at 10 minutes
                    return Math.min(v, cap);
                }
            }
        } catch (Exception ignored) {}
        return 90_000; // default 90s to allow slower provider responses
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens) {
        String provider = properties.ai().providerOrDefault();
        if ("gemini".equalsIgnoreCase(provider)) {
            return generateTextGemini(inputMessages, maxOutputTokens, properties.ai().snapshotOrDefault());
        }
        // Default: OpenAI Responses
        String preferredModel = properties.ai().snapshotOrDefault();
        return generateText(inputMessages, maxOutputTokens, preferredModel, true);
    }

    public Optional<String> generateText(List<Message> inputMessages, Integer maxOutputTokens, String overrideModel) {
        String provider = properties.ai().providerOrDefault();
        if ("gemini".equalsIgnoreCase(provider)) {
            return generateTextGemini(inputMessages, maxOutputTokens, overrideModel);
        }
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

    private Optional<String> generateTextGemini(List<Message> inputMessages, Integer maxOutputTokens, String model) {
        Optional<String> apiKey = resolveApiKey();
        if (apiKey.isEmpty()) {
            return Optional.empty();
        }
        String base = properties.ai().endpoint();
        // If endpoint is still the OpenAI default, swap to Gemini default
        if (base == null || base.isBlank() || base.contains("api.openai.com")) {
            base = "https://generativelanguage.googleapis.com/v1beta";
        }
        // Prefer query param for API key (header is also set for compatibility)
        String url = String.format("%s/models/%s:generateContent?key=%s", base, model, apiKey.get());

        ObjectNode root = objectMapper.createObjectNode();
        // Merge system messages into a single systemInstruction
        StringBuilder sys = new StringBuilder();
        for (Message m : inputMessages) {
            if ("system".equalsIgnoreCase(m.role()) && m.content() != null && !m.content().isBlank()) {
                if (!sys.isEmpty()) sys.append("\n\n");
                sys.append(m.content());
            }
        }
        if (!sys.isEmpty()) {
            ObjectNode si = root.putObject("systemInstruction");
            si.put("role", "system");
            ArrayNode parts = si.putArray("parts");
            parts.addObject().put("text", sys.toString());
        }

        ArrayNode contents = root.putArray("contents");
        for (Message m : inputMessages) {
            String role = m.role();
            if ("system".equalsIgnoreCase(role)) continue;
            String mapped = "user";
            if ("assistant".equalsIgnoreCase(role)) mapped = "model";
            ObjectNode c = contents.addObject();
            c.put("role", mapped);
            ArrayNode parts = c.putArray("parts");
            parts.addObject().put("text", m.content());
        }
    ObjectNode gen = root.putObject("generationConfig");
    int requestedMax = Optional.ofNullable(maxOutputTokens).filter(v -> v > 0).orElse(400);
    gen.put("maxOutputTokens", requestedMax);
        // Hint Gemini to return plain text (avoids tool/function responses for simple Q&A)
        gen.put("responseMimeType", "text/plain");

        try {
            JsonNode response = restClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .headers(h -> h.set("x-goog-api-key", apiKey.get()))
                    .body(root)
                    .retrieve()
                    .body(JsonNode.class);
            if (response == null) return Optional.empty();

            String text = extractGeminiText(response);
            String finishPrimary = null;
            JsonNode candidatesPrimary = response.get("candidates");
            if (candidatesPrimary != null && candidatesPrimary.isArray() && candidatesPrimary.size() > 0) {
                JsonNode cand0 = candidatesPrimary.get(0);
                JsonNode fr0 = cand0.get("finishReason");
                if (fr0 != null && fr0.isTextual()) finishPrimary = fr0.asText();
            }
            if (text != null && !text.isBlank()) {
                // If the model stopped due to token limit, attempt a one-time continuation
                if ("MAX_TOKENS".equalsIgnoreCase(finishPrimary) && requestedMax < 2048) {
                    try {
                        // Build a follow-up request that asks to continue exactly where it cut off
                        ObjectNode root2 = objectMapper.createObjectNode();
                        // carry forward any system instructions
                        if (root.has("systemInstruction")) {
                            root2.set("systemInstruction", root.get("systemInstruction"));
                        }
                        ArrayNode contents2 = root2.putArray("contents");
                        // original non-system messages (history up to this turn)
                        for (Message m : inputMessages) {
                            if ("system".equalsIgnoreCase(m.role())) continue;
                            ObjectNode c = contents2.addObject();
                            String mapped = "user";
                            if ("assistant".equalsIgnoreCase(m.role())) mapped = "model";
                            c.put("role", mapped);
                            ArrayNode parts = c.putArray("parts");
                            parts.addObject().put("text", m.content());
                        }
                        // include the just-produced partial assistant text so the model can continue seamlessly
                        if (text != null && !text.isBlank()) {
                            ObjectNode lastModel = contents2.addObject();
                            lastModel.put("role", "model");
                            ArrayNode lastParts = lastModel.putArray("parts");
                            lastParts.addObject().put("text", text);
                        }
                        // add an explicit continue instruction
                        ObjectNode cont = contents2.addObject();
                        cont.put("role", "user");
                        ArrayNode contParts = cont.putArray("parts");
                        contParts.addObject().put("text", "Continue the assistant's previous response. Continue exactly where it was cut off. Do not repeat sentences already given.");

                        ObjectNode gen2 = root2.putObject("generationConfig");
                        int followMax = Math.min(Math.max(requestedMax, 600), 2048);
                        gen2.put("maxOutputTokens", followMax);
                        gen2.put("responseMimeType", "text/plain");

                        JsonNode response2 = restClient.post()
                                .uri(url)
                                .contentType(MediaType.APPLICATION_JSON)
                                .headers(h -> h.set("x-goog-api-key", apiKey.get()))
                                .body(root2)
                                .retrieve()
                                .body(JsonNode.class);
                        String tail = extractGeminiText(response2);
                        if (tail != null && !tail.isBlank()) {
                            return Optional.of(text + (text.endsWith(" ") ? "" : " ") + tail);
                        }
                    } catch (Exception ex2) {
                        log.warn("Gemini continuation attempt failed: {}", ex2.getMessage());
                    }
                }
                return Optional.of(text);
            }

            // If no text extracted, try to surface a helpful reason instead of silent fallback
            String blockReason = null;
            JsonNode pf = response.get("promptFeedback");
            if (pf != null) {
                JsonNode br = pf.get("blockReason");
                if (br != null && br.isTextual()) {
                    blockReason = br.asText();
                }
            }
            String finish = finishPrimary;
            // If truncated due to max tokens, perform a one-time retry with a higher cap
            if ("MAX_TOKENS".equalsIgnoreCase(finish) && requestedMax < 2048) {
                int bumped = Math.min(Math.max(requestedMax * 2, requestedMax + 400), 2048);
                log.warn("Gemini finishReason=MAX_TOKENS with no text; retrying once with maxOutputTokens={}", bumped);
                return generateTextGemini(inputMessages, bumped, model);
            }
            if (blockReason != null || finish != null) {
                String msg = "(AI) Response unavailable" +
                        (finish != null ? ", finishReason=" + finish : "") +
                        (blockReason != null ? ", blockReason=" + blockReason : "") +
                        ". Please rephrase and try again.";
                log.warn("Gemini returned no text. finishReason={}, blockReason={}", finish, blockReason);
                return Optional.of(msg);
            }

            log.warn("Gemini returned no text content. Raw keys: {}", response.fieldNames().hasNext());
            return Optional.empty();
        } catch (RestClientResponseException ex) {
            String body = ex.getResponseBodyAsString();
            log.warn("Gemini call failed (status {}): {}{}", ex.getStatusCode(), ex.getMessage(),
                    body != null && !body.isBlank() ? "; body=" + truncate(body, 400) : "");
        } catch (Exception ex) {
            log.warn("Gemini call failed: {}", ex.getMessage());
        }
        return Optional.empty();
    }

    private String extractGeminiText(JsonNode node) {
        if (node == null) return null;
        JsonNode candidates = node.get("candidates");
        if (candidates != null && candidates.isArray()) {
            for (JsonNode cand : candidates) {
                JsonNode content = cand.get("content");
                if (content != null) {
                    JsonNode parts = content.get("parts");
                    if (parts != null && parts.isArray()) {
                        for (JsonNode part : parts) {
                            String t = extractText(part.get("text"));
                            if (t != null && !t.isBlank()) return t;
                            // Some responses may put text directly at top level of part
                            String direct = extractText(part);
                            if (direct != null && !direct.isBlank()) return direct;
                        }
                    }
                }
            }
        }
        return null;
    }

    private String truncate(String s, int max) {
        if (s == null) return null;
        if (s.length() <= max) return s;
        return s.substring(0, Math.max(0, max)) + "…";
    }

    private Optional<String> resolveApiKey() {
        String provider = properties.ai().providerOrDefault();

        // Prefer provider-specific environment variables first to avoid cross-provider misuse
        if ("gemini".equalsIgnoreCase(provider)) {
            String env = System.getenv("GEMINI_API_KEY");
            if (env != null && !env.isBlank()) return Optional.of(env);
            // Do NOT fall back to ai.apiKey when it is wired to OPENAI_API_KEY in config.
            // Only use explicit ai.apiKey if caller overrides it with a Gemini key.
            String configured = properties.ai().apiKey();
            if (configured != null && !configured.isBlank()) return Optional.of(configured);
            return Optional.empty();
        }

        // openai default
        String configured = properties.ai().apiKey();
        if (configured != null && !configured.isBlank()) return Optional.of(configured);
        String env = System.getenv("OPENAI_API_KEY");
        if (env != null && !env.isBlank()) return Optional.of(env);
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
