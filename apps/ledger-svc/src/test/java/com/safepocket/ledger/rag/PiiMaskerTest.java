package com.safepocket.ledger.rag;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PiiMaskerTest {

    @Test
    void masksAccountAndPhone() {
        String input = "Call me at 090-1234-5678, account 123456789012 please deliver to 123 Main Street.";
        String masked = PiiMasker.mask(input);
        assertThat(masked).doesNotContain("123456789012").doesNotContain("090-1234-5678").contains("***");
    }
}
