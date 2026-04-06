package com.safepocket.ledger.controller;

import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.safepocket.ledger.user.UserDeletionService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = {
        "spring.profiles.active=test",
        "ADMIN_SQL_TOKEN=test-admin-token"
})
@AutoConfigureMockMvc
class UserControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private UserDeletionService userDeletionService;

    @Test
    void deleteUserRequiresAdminToken() throws Exception {
        UUID userId = UUID.randomUUID();

        mockMvc.perform(delete("/users/{userId}", userId)
                        .with(jwt().jwt(jwt -> jwt.subject(UUID.randomUUID().toString()))))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));

        verifyNoInteractions(userDeletionService);
    }

    @Test
    void deleteUserRejectsInvalidAdminToken() throws Exception {
        UUID userId = UUID.randomUUID();

        mockMvc.perform(delete("/users/{userId}", userId)
                        .header("X-Admin-Token", "wrong-token")
                        .with(jwt().jwt(jwt -> jwt.subject(UUID.randomUUID().toString()))))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));

        verifyNoInteractions(userDeletionService);
    }

    @Test
    void deleteUserAllowsValidAdminToken() throws Exception {
        UUID userId = UUID.randomUUID();

        mockMvc.perform(delete("/users/{userId}", userId)
                        .header("X-Admin-Token", "test-admin-token")
                        .with(jwt().jwt(jwt -> jwt.subject(UUID.randomUUID().toString()))))
                .andExpect(status().isNoContent());

        verify(userDeletionService).deleteUser(userId);
    }
}
