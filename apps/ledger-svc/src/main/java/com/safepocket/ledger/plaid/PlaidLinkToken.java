package com.safepocket.ledger.plaid;

import java.time.Instant;

public record PlaidLinkToken(String linkToken, Instant expiration, String requestId) {
}
