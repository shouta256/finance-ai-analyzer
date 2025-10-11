import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetPlaidLoaderForTests, loadPlaidLink } from "../plaid";

describe("loadPlaidLink", () => {
  beforeEach(() => {
    __resetPlaidLoaderForTests();
    delete (window as any).Plaid;
    const existing = document.getElementById("plaid-link-script");
    if (existing?.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  });

  afterEach(() => {
    __resetPlaidLoaderForTests();
    delete (window as any).Plaid;
    const existing = document.getElementById("plaid-link-script");
    if (existing?.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  });

  it("resolves immediately when Plaid already available", async () => {
    const factory = { create: vi.fn() };
    (window as any).Plaid = factory;
    await expect(loadPlaidLink()).resolves.toBe(factory);
  });

  it("injects script and resolves after load event", async () => {
    const promise = loadPlaidLink(5000);
    const script = document.getElementById("plaid-link-script") as HTMLScriptElement | null;
    expect(script).not.toBeNull();
    const factory = { create: vi.fn() };
    (window as any).Plaid = factory;
    script?.dispatchEvent(new Event("load"));
    await expect(promise).resolves.toBe(factory);
  });
});
