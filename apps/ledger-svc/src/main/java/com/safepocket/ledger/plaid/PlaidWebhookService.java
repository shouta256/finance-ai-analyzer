package com.safepocket.ledger.plaid;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Service;

@Service
public class PlaidWebhookService {
    private static final Logger log = LoggerFactory.getLogger(PlaidWebhookService.class);

    private final Environment environment;
    private final PlaidClient plaidClient;

    public PlaidWebhookService(Environment environment, PlaidClient plaidClient) {
        this.environment = environment;
        this.plaidClient = plaidClient;
    }

    /**
     * Verify Plaid webhook signature per https://plaid.com/docs/api/webhooks/webhook-verification/
     * Sandbox may send Plaid-Verification for testing. If PLAID_WEBHOOK_SECRET is unset:
     * - in prod: reject
     * - in non-prod: allow (logs a warning)
     */
    public boolean verifySignature(String rawBody, String jwtHeader, String unused) {
        // Plaid-Verification is a JWT signed with ES256; kid is in JWT header
        if (jwtHeader == null || jwtHeader.isBlank()) {
            if (environment.acceptsProfiles(Profiles.of("prod"))) {
                log.warn("Missing Plaid-Verification JWT header (prod)");
                return false;
            }
            log.warn("Missing Plaid-Verification JWT header; accepting in non-prod");
            return true;
        }
        try {
            String jwt = jwtHeader.trim();
            String[] parts = jwt.split("\\.");
            if (parts.length != 3) return false;
            String headerJson = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            Map<?,?> header = new com.fasterxml.jackson.databind.ObjectMapper().readValue(headerJson, Map.class);
            String kid = String.valueOf(header.get("kid"));
            if (kid == null || kid.isBlank()) return false;

            var jwkResp = plaidClient.getWebhookVerificationKey(kid);
            var key = jwkResp.key();
            if (!"EC".equals(key.kty()) || !"P-256".equals(key.crv())) {
                log.warn("Unexpected JWK type/crv: {} / {}", key.kty(), key.crv());
                return false;
            }

            // Build ECPublicKey from x,y (secp256r1)
            byte[] x = Base64.getUrlDecoder().decode(key.x());
            byte[] y = Base64.getUrlDecoder().decode(key.y());
            ECPoint ecPoint = new ECPoint(new BigInteger(1, x), new BigInteger(1, y));
            ECGenParameterSpec genSpec = new ECGenParameterSpec("secp256r1");
            AlgorithmParameters ap = AlgorithmParameters.getInstance("EC");
            ap.init(genSpec);
            ECParameterSpec ecSpec = ap.getParameterSpec(ECParameterSpec.class);
            ECPublicKeySpec pubSpec = new ECPublicKeySpec(ecPoint, ecSpec);
            PublicKey publicKey = KeyFactory.getInstance("EC").generatePublic(pubSpec);

            // Verify ES256 signature over header.payload
            byte[] signed = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8);
            byte[] jwsSig = Base64.getUrlDecoder().decode(parts[2]);
            byte[] derSig = jwsEs256ToDer(jwsSig);
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(publicKey);
            verifier.update(signed);
            if (!verifier.verify(derSig)) {
                log.warn("Invalid Plaid JWT signature");
                return false;
            }

            String payloadJson = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            Map<?,?> payload = new com.fasterxml.jackson.databind.ObjectMapper().readValue(payloadJson, Map.class);
            Number iat = (Number) payload.get("iat");
            String bodySha256 = (String) payload.get("request_body_sha256");
            if (iat == null || bodySha256 == null) return false;
            long now = Instant.now().getEpochSecond();
            if (now - iat.longValue() > 300) {
                log.warn("Plaid JWT too old (replay?) iat={}", iat);
                return false;
            }

            // Compute SHA-256 of raw body and compare (base16 lowercase expected)
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(rawBody.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            String computed = sb.toString();
            boolean ok = constantTimeEquals(computed, bodySha256);
            if (!ok) log.warn("Webhook body hash mismatch");
            return ok;
        } catch (Exception e) {
            log.warn("Failed JWT verify for Plaid webhook: {}", e.getMessage());
            return false;
        }
    }

    // Convert JOSE (R||S) signature to ASN.1 DER sequence expected by Java Signature
    private byte[] jwsEs256ToDer(byte[] jws) {
        if (jws.length != 64) return jws; // fallback (unexpected length)
        byte[] r = new byte[32];
        byte[] s = new byte[32];
        System.arraycopy(jws, 0, r, 0, 32);
        System.arraycopy(jws, 32, s, 0, 32);
        BigInteger rInt = new BigInteger(1, r);
        BigInteger sInt = new BigInteger(1, s);
        byte[] rEnc = toDerInteger(rInt);
        byte[] sEnc = toDerInteger(sInt);
        int len = 2 + rEnc.length + 2 + sEnc.length;
        byte[] seq = new byte[2 + len];
        seq[0] = 0x30;
        seq[1] = (byte) len;
        seq[2] = 0x02; seq[3] = (byte) rEnc.length;
        System.arraycopy(rEnc, 0, seq, 4, rEnc.length);
        int off = 4 + rEnc.length;
        seq[off] = 0x02; seq[off+1] = (byte) sEnc.length;
        System.arraycopy(sEnc, 0, seq, off+2, sEnc.length);
        return seq;
    }

    private byte[] toDerInteger(BigInteger v) {
        byte[] raw = v.toByteArray();
        if (raw[0] == 0x00 && raw.length > 1) {
            // remove unnecessary leading zero except when needed for sign bit
            int i = 0; while (i < raw.length-1 && raw[i] == 0x00) i++;
            byte[] trimmed = new byte[raw.length - i];
            System.arraycopy(raw, i, trimmed, 0, trimmed.length);
            raw = trimmed;
        }
        if ((raw[0] & 0x80) != 0) {
            // add leading zero to force positive
            byte[] prefixed = new byte[raw.length + 1];
            System.arraycopy(raw, 0, prefixed, 1, raw.length);
            raw = prefixed;
        }
        return raw;
    }

    private boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        if (a.length() != b.length()) return false;
        int res = 0;
        for (int i = 0; i < a.length(); i++) {
            res |= a.charAt(i) ^ b.charAt(i);
        }
        return res == 0;
    }

    public void process(Map<String, Object> body, String signature) {
        String webhookType = str(body.get("webhook_type"));
        String webhookCode = str(body.get("webhook_code"));
        String itemId = str(body.get("item_id"));
    // Signature is verified in controller via verifySignature()

        log.info("Plaid webhook received type={} code={} item={} at={} signaturePresent={}", webhookType, webhookCode, itemId, Instant.now(), signature != null);

        if ("TRANSACTIONS".equalsIgnoreCase(webhookType)) {
            handleTransactionsWebhook(webhookCode, body);
        } else {
            log.warn("Unhandled Plaid webhook type={} code={}", webhookType, webhookCode);
        }
    }

    private void handleTransactionsWebhook(String code, Map<String, Object> body) {
        switch (code) {
            case "INITIAL_UPDATE" -> log.info("Transactions INITIAL_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "HISTORICAL_UPDATE" -> log.info("Transactions HISTORICAL_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "DEFAULT_UPDATE" -> log.info("Transactions DEFAULT_UPDATE: new_transactions={}", body.get("new_transactions"));
            case "TRANSACTIONS_REMOVED" -> log.info("Transactions REMOVED: removed_transactions={}", body.get("removed_transactions"));
            case "SYNC_UPDATES_AVAILABLE" -> log.info("Transactions SYNC_UPDATES_AVAILABLE" );
            default -> log.warn("Unknown transactions webhook code={}", code);
        }
        // TODO: enqueue background sync job / diff reconcile
    }

    private String str(Object o) { return o == null ? null : String.valueOf(o); }
}
