package com.safepocket.ledger.security;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class KmsEnvelopeEncryptor implements AccessTokenEncryptor {

    private static final Logger log = LoggerFactory.getLogger(KmsEnvelopeEncryptor.class);
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final int IV_LENGTH_BYTES = 12;

    private final SecretKey secretKey;
    private final SecureRandom secureRandom = new SecureRandom();

    public KmsEnvelopeEncryptor(@Value("${SAFEPOCKET_KMS_DATA_KEY:}") String keyMaterial) {
        byte[] keyBytes;
        if (keyMaterial != null && !keyMaterial.isBlank()) {
            keyBytes = Base64.getDecoder().decode(keyMaterial);
        } else {
            keyBytes = new byte[32];
            secureRandom.nextBytes(keyBytes);
            log.warn("SAFEPOCKET_KMS_DATA_KEY not provided; generated volatile key for runtime only");
        }
        this.secretKey = new SecretKeySpec(keyBytes, "AES");
    }

    @Override
    public String encrypt(String plaintext) {
        if (plaintext == null || plaintext.isBlank()) {
            throw new IllegalArgumentException("Plaintext must not be blank");
        }
        try {
            byte[] iv = new byte[IV_LENGTH_BYTES];
            secureRandom.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] cipherText = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            ByteBuffer buffer = ByteBuffer.allocate(iv.length + cipherText.length);
            buffer.put(iv);
            buffer.put(cipherText);
            return Base64.getEncoder().encodeToString(buffer.array());
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Failed to encrypt access token", ex);
        }
    }

    @Override
    public String decrypt(String ciphertext) {
        if (ciphertext == null || ciphertext.isBlank()) {
            throw new IllegalArgumentException("Ciphertext must not be blank");
        }
        try {
            byte[] decoded = Base64.getDecoder().decode(ciphertext);
            byte[] iv = new byte[IV_LENGTH_BYTES];
            byte[] actualCiphertext = new byte[decoded.length - IV_LENGTH_BYTES];
            System.arraycopy(decoded, 0, iv, 0, IV_LENGTH_BYTES);
            System.arraycopy(decoded, IV_LENGTH_BYTES, actualCiphertext, 0, actualCiphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] plainBytes = cipher.doFinal(actualCiphertext);
            return new String(plainBytes, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Failed to decrypt access token", ex);
        }
    }
}
