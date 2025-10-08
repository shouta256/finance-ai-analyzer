package com.safepocket.ledger.plaid;

import com.safepocket.ledger.config.SafepocketProperties;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Minimal test verifying JSON → record mapping for PlaidClient using an embedded HttpServer.
 */
public class PlaidClientTest {

    static com.sun.net.httpserver.HttpServer server;
    static int port;

    @BeforeAll
    static void start() throws IOException {
        server = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
        server.createContext("/link/token/create", exchange -> {
            String json = "{\n" +
                    "  \"link_token\": \"lt-sandbox-123\",\n" +
                    "  \"expiration\": \"" + Instant.now().plusSeconds(1800).toString() + "\",\n" +
                    "  \"request_id\": \"req-1\"\n" +
                    "}";
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, json.getBytes().length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(json.getBytes()); }
        });
        server.createContext("/item/public_token/exchange", exchange -> {
            String json = "{\n" +
                    "  \"access_token\": \"access-sandbox-xyz\",\n" +
                    "  \"item_id\": \"item-123\",\n" +
                    "  \"request_id\": \"req-2\"\n" +
                    "}";
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, json.getBytes().length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(json.getBytes()); }
        });
        server.setExecutor(Executors.newSingleThreadExecutor());
        server.start();
    }

    @AfterAll
    static void stop() {
        server.stop(0);
    }

    private PlaidClient newClient() {
    var props = new SafepocketProperties(
        new SafepocketProperties.Cognito("issuer","aud", true),
        new SafepocketProperties.Plaid("cid","secret","https://redirect","http://localhost:" + port, "sandbox", null, null),
        new SafepocketProperties.Ai("model","endpoint", null,null),
        new SafepocketProperties.Security(null)
    );
        return new PlaidClient(props);
    }

    @Test
    void createLinkToken_mapsJson() {
        var client = newClient();
        var res = client.createLinkToken("user-1");
        assertEquals("lt-sandbox-123", res.linkToken());
        assertEquals("req-1", res.requestId());
        assertNotNull(res.expiration());
    }

    @Test
    void exchangePublicToken_mapsJson() {
        var client = newClient();
        var res = client.exchangePublicToken("public-abc");
        assertEquals("item-123", res.itemId());
        assertEquals("access-sandbox-xyz", res.accessToken());
        assertEquals("req-2", res.requestId());
    }
}
