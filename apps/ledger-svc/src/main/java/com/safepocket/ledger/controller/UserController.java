package com.safepocket.ledger.controller;

import com.safepocket.ledger.user.UserDeletionService;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/users")
public class UserController {

    private final UserDeletionService userDeletionService;

    public UserController(UserDeletionService userDeletionService) {
        this.userDeletionService = userDeletionService;
    }

    @DeleteMapping("/{userId}")
    public ResponseEntity<Void> deleteUser(@PathVariable UUID userId) {
        userDeletionService.deleteUser(userId);
        return ResponseEntity.noContent().build();
    }
}
