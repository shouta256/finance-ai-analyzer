package com.safepocket.ledger.security;

import java.util.Optional;
import java.util.UUID;

public final class RequestContextHolder {

    private static final ThreadLocal<RequestContext> CONTEXT = new ThreadLocal<>();

    private RequestContextHolder() {
    }

    public static void set(RequestContext context) {
        CONTEXT.set(context);
    }

    public static void setUserId(UUID userId) {
        RequestContext current = CONTEXT.get();
        if (current == null) {
            current = RequestContext.builder().traceId(null).build();
        }
        CONTEXT.set(RequestContext.builder()
                .traceId(current.traceId())
                .userId(userId)
                .build());
    }

    public static Optional<RequestContext> get() {
        return Optional.ofNullable(CONTEXT.get());
    }

    public static void clear() {
        CONTEXT.remove();
    }

    public record RequestContext(UUID userId, String traceId) {

        public static Builder builder() {
            return new Builder();
        }

        public static final class Builder {
            private UUID userId;
            private String traceId;

            public Builder userId(UUID userId) {
                this.userId = userId;
                return this;
            }

            public Builder traceId(String traceId) {
                this.traceId = traceId;
                return this;
            }

            public RequestContext build() {
                return new RequestContext(userId, traceId);
            }
        }
    }
}
