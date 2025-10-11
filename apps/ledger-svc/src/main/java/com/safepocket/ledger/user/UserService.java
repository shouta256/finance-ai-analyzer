package com.safepocket.ledger.user;

import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class UserService {
    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public void ensureUserExists(UUID userId, String email, String fullName) {
        if (userRepository.existsById(userId)) return;
        // fallbacks for missing claims
        String safeEmail = (email == null || email.isBlank()) ? (userId.toString() + "@users.safepocket") : email;
        String safeName = (fullName == null || fullName.isBlank()) ? "User" : fullName;
        userRepository.save(new UserEntity(userId, safeEmail, safeName));
    }
}
