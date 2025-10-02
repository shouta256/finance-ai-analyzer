package com.safepocket.ledger.security;

public interface AccessTokenEncryptor {
    String encrypt(String plaintext);
    String decrypt(String ciphertext);
}
