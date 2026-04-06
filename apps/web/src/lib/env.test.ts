import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnvModule() {
  vi.resetModules();
  return import("./env");
}

describe("env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers explicit ledger service URL when provided", async () => {
    vi.stubEnv("LEDGER_SERVICE_URL", "https://ledger.example.com/");
    vi.stubEnv("SAFEPOCKET_API_BASE", "https://api.example.com/");

    const { env } = await loadEnvModule();

    expect(env.LEDGER_SERVICE_URL).toBe("https://ledger.example.com");
  });

  it("falls back to SAFEPOCKET_API_BASE for domain API routing", async () => {
    vi.stubEnv("SAFEPOCKET_API_BASE", "https://api.example.com/prod/");

    const { env } = await loadEnvModule();

    expect(env.LEDGER_SERVICE_URL).toBe("https://api.example.com/prod");
  });
});
