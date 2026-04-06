package com.safepocket.ledger.controller;

import com.safepocket.ledger.config.SafepocketProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import com.safepocket.ledger.user.UserDeletionService;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/users")
public class UserController {

    private final UserDeletionService userDeletionService;
    private final SafepocketProperties properties;

    public UserController(UserDeletionService userDeletionService, SafepocketProperties properties) {
        this.userDeletionService = userDeletionService;
        this.properties = properties;
    }

    @DeleteMapping("/{userId}")
    public ResponseEntity<Void> deleteUser(
            @PathVariable UUID userId,
            @RequestHeader(value = "X-Admin-Token", required = false) String adminToken
    ) {
        verifyAdminToken(adminToken);
        userDeletionService.deleteUser(userId);
        return ResponseEntity.noContent().build();
    }

    private void verifyAdminToken(String suppliedToken) {
        String configuredToken = properties.security().adminToken();
        if (configuredToken == null || configuredToken.isBlank()) {
            throw new AccessDeniedException("User deletion is disabled without SAFEPOCKET security admin token configuration");
        }
        if (suppliedToken == null || suppliedToken.isBlank()) {
            throw new AccessDeniedException("X-Admin-Token header is required for user deletion");
        }
        byte[] expected = configuredToken.getBytes(StandardCharsets.UTF_8);
        byte[] supplied = suppliedToken.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(expected, supplied)) {
            throw new AccessDeniedException("Invalid admin token");
        }
    }
}
