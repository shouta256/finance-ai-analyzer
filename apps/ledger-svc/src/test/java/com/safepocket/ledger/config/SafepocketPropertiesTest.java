package com.safepocket.ledger.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SafepocketPropertiesTest {

    @Test
    void cognitoEnabledFlagRespectsFalse() {
    SafepocketProperties props = new SafepocketProperties(
        new SafepocketProperties.Cognito("https://example.com","aud", false),
        new SafepocketProperties.Plaid("id","sec","redir","base","env",null,null),
        new SafepocketProperties.Ai("openai","model","https://api.example.com",null,null),
        new SafepocketProperties.Security("12345678901234567890123456789012")
    );

        assertFalse(props.cognito().enabledFlag());
    }
}
