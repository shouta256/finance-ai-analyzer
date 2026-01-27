"use strict";

const crypto = require("crypto");
const AWS = require("aws-sdk");
const kms = new AWS.KMS();

const { createHttpError } = require("./helpers");

// Encryption configuration
const DATA_KEY_RAW = process.env.SAFEPOCKET_KMS_DATA_KEY || "";
const KMS_KEY_ID = process.env.SAFEPOCKET_KMS_KEY_ID || "";

/**
 * Parse symmetric key from environment
 */
function parseSymmetricKey(raw) {
  if (!raw) return null;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44) {
      const decoded = Buffer.from(raw, "base64");
      if (decoded.length === 32) return decoded;
    }
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
      return Buffer.from(raw, "hex");
    }
  } catch {
    return null;
  }
  return null;
}

const SYM_KEY = parseSymmetricKey(DATA_KEY_RAW);

/**
 * Encrypt a secret value (Plaid access token, etc.)
 */
async function encryptSecret(plain) {
  if (SYM_KEY) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", SYM_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `v1:gcm:${iv.toString("base64")}:${encrypted.toString("base64")}:${authTag.toString("base64")}`;
  }
  if (KMS_KEY_ID) {
    const out = await kms
      .encrypt({
        KeyId: KMS_KEY_ID,
        Plaintext: Buffer.from(String(plain), "utf8"),
      })
      .promise();
    return `v1:kms:${out.CiphertextBlob.toString("base64")}`;
  }
  throw createHttpError(500, "Encryption key is not configured (set SAFEPOCKET_KMS_DATA_KEY or SAFEPOCKET_KMS_KEY_ID)");
}

/**
 * Decrypt a secret value
 */
async function decryptSecret(blob) {
  if (!blob || typeof blob !== "string") return null;
  const parts = blob.split(":");
  if (parts[0] !== "v1") return null;
  if (parts[1] === "gcm" && SYM_KEY) {
    const iv = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const tag = Buffer.from(parts[4], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SYM_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  }
  if (parts[1] === "kms" && KMS_KEY_ID) {
    const decrypted = await kms
      .decrypt({ CiphertextBlob: Buffer.from(parts[2], "base64") })
      .promise();
    return decrypted.Plaintext.toString("utf8");
  }
  throw createHttpError(500, "Unable to decrypt secret with current configuration");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};
