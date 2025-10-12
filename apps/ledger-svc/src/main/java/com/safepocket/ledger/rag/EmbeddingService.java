package com.safepocket.ledger.rag;

import com.safepocket.ledger.config.SafepocketProperties;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/**
 * Simplified embedding service. In production we can wire an OpenAI embedding client,
 * but by default we fall back to a deterministic hash-based embedding to keep tests offline.
 */
@Component
public class EmbeddingService {

    private static final Logger log = LoggerFactory.getLogger(EmbeddingService.class);

    private final SafepocketProperties properties;
    private final MessageDigest digest;
    private final WebClient http;

    public EmbeddingService(SafepocketProperties properties) {
        this.properties = properties;
        try {
            this.digest = MessageDigest.getInstance("SHA-512");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-512 digest unavailable", e);
        }
        this.http = WebClient.builder()
                .build();
    }

    /**
     * Primary embedding entrypoint. Uses Gemini when configured and an API key is available;
     * otherwise falls back to deterministic offline embedding for reproducible tests.
     */
    public float[] embed(String text) {
        try {
            if (shouldUseGemini()) {
                float[] v = embedWithGemini(text);
                if (v != null && v.length > 0) {
                    return reshapeToDimension(v, properties.rag().embedDimension());
                }
            }
        } catch (Exception ex) {
            log.warn("Gemini embedding failed, falling back to deterministic embedding: {}", ex.toString());
        }
        return embedDeterministic(text);
    }

    public float[] embedDeterministic(String text) {
        String normalized = text == null ? "" : text.toLowerCase(Locale.ROOT).trim();
        if (normalized.isEmpty()) {
            normalized = "empty";
        }
        byte[] seed = digest.digest(normalized.getBytes());
        int dimension = properties.rag().embedDimension();
        float[] vector = new float[dimension];
        ByteBuffer buffer = ByteBuffer.wrap(seed).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < dimension; i++) {
            if (buffer.remaining() < Float.BYTES) {
                buffer.rewind();
            }
            vector[i] = normalize(buffer.getFloat());
        }
        return vector;
    }

    private boolean shouldUseGemini() {
        String model = properties.rag().embeddingModel();
        // Heuristic: use Gemini if embedding model looks like Gemini's or AI provider is gemini
        boolean modelSuggestsGemini = model != null && model.toLowerCase(Locale.ROOT).contains("text-embedding-004");
        String provider = properties.ai().providerOrDefault();
        boolean providerIsGemini = provider.equalsIgnoreCase("gemini") || provider.equalsIgnoreCase("google");
        String geminiKey = System.getenv("GEMINI_API_KEY");
        String aiKey = properties.ai().apiKey();
        // Prefer explicit GEMINI_API_KEY; otherwise allow ai.apiKey when provider is gemini
        boolean hasKey = (geminiKey != null && !geminiKey.isBlank()) || (providerIsGemini && aiKey != null && !aiKey.isBlank());
        return hasKey && (modelSuggestsGemini || providerIsGemini);
    }

    private float[] embedWithGemini(String text) {
        String normalized = text == null ? "" : text.trim();
        if (normalized.isBlank()) {
            normalized = "empty";
        }
        String model = properties.rag().embeddingModel();
        if (model == null || model.isBlank()) {
            model = "text-embedding-004"; // sensible default
        }
        String modelPath = model.startsWith("models/") ? model : ("models/" + model);

        String apiKey = System.getenv("GEMINI_API_KEY");
        if ((apiKey == null || apiKey.isBlank()) && properties.ai().providerOrDefault().equalsIgnoreCase("gemini")) {
            apiKey = properties.ai().apiKey();
        }
        if (apiKey == null || apiKey.isBlank()) {
            log.debug("No Gemini API key configured; skipping remote embed.");
            return new float[0];
        }

        String base = properties.ai().endpoint();
        if (base == null || base.isBlank() || !base.contains("generativelanguage.googleapis.com")) {
            base = "https://generativelanguage.googleapis.com/v1beta";
        }
        String url = base + "/" + modelPath + ":embedContent?key=" + apiKey;

        GeminiEmbedRequest body = new GeminiEmbedRequest(new Content(new Part(normalized)));
        try {
            GeminiEmbedResponse resp = this.http.post()
                    .uri(URI.create(url))
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(GeminiEmbedResponse.class)
                    .block(Duration.ofSeconds(10));
            if (resp == null) {
                return new float[0];
            }
            if (resp.embedding != null && resp.embedding.values != null) {
                return resp.embedding.values;
            }
            if (resp.embeddings != null && resp.embeddings.length > 0 && resp.embeddings[0].values != null) {
                return resp.embeddings[0].values;
            }
            return new float[0];
        } catch (WebClientResponseException e) {
            log.warn("Gemini embed HTTP {}: {}", e.getStatusCode().value(), e.getResponseBodyAsString());
            return new float[0];
        }
    }

    private float[] reshapeToDimension(float[] source, int targetDim) {
        if (source.length == targetDim) return source;
        float[] out = new float[targetDim];
        int n = Math.min(source.length, targetDim);
        System.arraycopy(source, 0, out, 0, n);
        // remaining positions default to 0.0f
        return out;
    }

    private float normalize(float value) {
        if (Float.isNaN(value) || Float.isInfinite(value)) {
            return 0f;
        }
        return (float) (value / Math.sqrt(1 + value * value));
    }

    public String formatForSql(float[] vector) {
        StringBuilder sb = new StringBuilder();
        sb.append('[');
        for (int i = 0; i < vector.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(String.format(Locale.US, "%.6f", vector[i]));
        }
        sb.append(']');
        return sb.toString();
    }

    // --- DTOs for Gemini embedContent API ---
    static class GeminiEmbedRequest {
        public final Content content;
        GeminiEmbedRequest(Content content) { this.content = content; }
    }
    static class Content {
        public final Part[] parts;
        Content(Part part) { this.parts = new Part[]{part}; }
    }
    static class Part {
        public final String text;
        Part(String text) { this.text = text; }
    }
    static class GeminiEmbedResponse {
        public GeminiEmbedding embedding;      // single mode
        public GeminiEmbedding[] embeddings;   // batch mode
    }
    static class GeminiEmbedding {
        public float[] values;
    }
}
