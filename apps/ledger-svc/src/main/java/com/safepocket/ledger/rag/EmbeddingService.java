package com.safepocket.ledger.rag;

import com.safepocket.ledger.config.SafepocketProperties;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Simplified embedding service. In production we can wire an OpenAI embedding client,
 * but by default we fall back to a deterministic hash-based embedding to keep tests offline.
 */
@Component
public class EmbeddingService {

    private static final Logger log = LoggerFactory.getLogger(EmbeddingService.class);

    private final SafepocketProperties properties;
    private final MessageDigest digest;

    public EmbeddingService(SafepocketProperties properties) {
        this.properties = properties;
        try {
            this.digest = MessageDigest.getInstance("SHA-512");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-512 digest unavailable", e);
        }
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
}
