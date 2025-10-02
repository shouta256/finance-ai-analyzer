package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import com.safepocket.ledger.security.AccessTokenEncryptor;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class PlaidService {

    private final PlaidItemRepository plaidItemRepository;
    private final AccessTokenEncryptor accessTokenEncryptor;
    private final SafepocketProperties properties;

    public PlaidService(
            PlaidItemRepository plaidItemRepository,
            AccessTokenEncryptor accessTokenEncryptor,
            SafepocketProperties properties
    ) {
        this.plaidItemRepository = plaidItemRepository;
        this.accessTokenEncryptor = accessTokenEncryptor;
        this.properties = properties;
    }

    public PlaidLinkToken createLinkToken(UUID userId) {
        String linkToken = "link-token-" + UUID.randomUUID();
        Instant expiration = Instant.now().plus(30, ChronoUnit.MINUTES);
        String requestId = "req-" + UUID.randomUUID();
        return new PlaidLinkToken(linkToken, expiration, requestId);
    }

    public PlaidItem exchangePublicToken(UUID userId, String publicToken) {
        // In the sandbox, exchanging a public token yields an access token and item id.
        String itemId = "item-" + UUID.randomUUID();
        String accessToken = "access-" + publicToken;
        String encrypted = accessTokenEncryptor.encrypt(accessToken);
        PlaidItem plaidItem = new PlaidItem(userId, itemId, encrypted, Instant.now());
        plaidItemRepository.save(plaidItem);
        return plaidItem;
    }

    public String decryptAccessToken(PlaidItem item) {
        return accessTokenEncryptor.decrypt(item.encryptedAccessToken());
    }

    public SafepocketProperties.Plaid plaidProperties() {
        return properties.plaid();
    }
}
