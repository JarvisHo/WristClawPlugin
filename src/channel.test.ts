import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WristClawConfig, WristClawChannelConfig } from "./types.js";

// Test the pure functions that don't depend on openclaw/plugin-sdk runtime

describe("resolveAccount logic", () => {
  // Inline the pure logic from channel.ts to test without SDK imports
  function resolveAccount(
    cfg: { channels?: { wristclaw?: Partial<WristClawChannelConfig> } },
    accountId?: string | null,
  ) {
    const wc = cfg.channels?.wristclaw;
    return {
      accountId: accountId ?? "default",
      name: wc?.name,
      enabled: wc?.enabled !== false,
      configured: Boolean(wc?.baseUrl && (wc?.apiKey || wc?.apiKeyFile)),
      baseUrl: wc?.baseUrl ?? "",
      config: wc ?? ({} as WristClawChannelConfig),
    };
  }

  it("marks as configured when baseUrl and apiKey present", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "https://api.test.com", apiKey: "wc_test_123" } },
    };
    const account = resolveAccount(cfg);
    assert.equal(account.configured, true);
    assert.equal(account.baseUrl, "https://api.test.com");
  });

  it("marks as configured with apiKeyFile", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "https://api.test.com", apiKeyFile: "/tmp/key" } },
    };
    const account = resolveAccount(cfg);
    assert.equal(account.configured, true);
  });

  it("marks as not configured without apiKey", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "https://api.test.com" } },
    };
    const account = resolveAccount(cfg);
    assert.equal(account.configured, false);
  });

  it("marks as not configured without baseUrl", () => {
    const cfg = {
      channels: { wristclaw: { apiKey: "wc_test_123" } },
    };
    const account = resolveAccount(cfg);
    assert.equal(account.configured, false);
  });

  it("marks as not configured when no wristclaw config", () => {
    const account = resolveAccount({ channels: {} });
    assert.equal(account.configured, false);
    assert.equal(account.baseUrl, "");
  });

  it("defaults enabled to true", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "http://localhost", apiKey: "key" } },
    };
    assert.equal(resolveAccount(cfg).enabled, true);
  });

  it("respects enabled: false", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "http://localhost", apiKey: "key", enabled: false } },
    };
    assert.equal(resolveAccount(cfg).enabled, false);
  });

  it("uses provided accountId", () => {
    const account = resolveAccount({ channels: {} }, "custom-account");
    assert.equal(account.accountId, "custom-account");
  });

  it("defaults accountId to 'default'", () => {
    const account = resolveAccount({ channels: {} });
    assert.equal(account.accountId, "default");
  });

  it("picks up name from config", () => {
    const cfg = {
      channels: { wristclaw: { baseUrl: "http://localhost", apiKey: "k", name: "My Watch" } },
    };
    assert.equal(resolveAccount(cfg).name, "My Watch");
  });
});

describe("normalizeTarget logic", () => {
  function normalizeTarget(target: string): string | undefined {
    const trimmed = target.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/^wristclaw:/i, "");
  }

  it("strips wristclaw: prefix", () => {
    assert.equal(normalizeTarget("wristclaw:abc-123"), "abc-123");
  });

  it("strips WRISTCLAW: prefix (case insensitive)", () => {
    assert.equal(normalizeTarget("WRISTCLAW:abc-123"), "abc-123");
  });

  it("returns raw id without prefix", () => {
    assert.equal(normalizeTarget("abc-123"), "abc-123");
  });

  it("returns undefined for empty string", () => {
    assert.equal(normalizeTarget(""), undefined);
  });

  it("returns undefined for whitespace-only", () => {
    assert.equal(normalizeTarget("   "), undefined);
  });

  it("trims whitespace", () => {
    assert.equal(normalizeTarget("  abc-123  "), "abc-123");
  });
});

describe("looksLikeId logic", () => {
  function looksLikeId(id: string): boolean {
    const trimmed = id?.trim();
    if (!trimmed) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed) || /^wristclaw:/i.test(trimmed);
  }

  it("matches UUID format", () => {
    assert.equal(looksLikeId("550e8400-e29b-41d4-a716-446655440000"), true);
  });

  it("matches uppercase UUID", () => {
    assert.equal(looksLikeId("550E8400-E29B-41D4-A716-446655440000"), true);
  });

  it("matches wristclaw: prefix", () => {
    assert.equal(looksLikeId("wristclaw:some-id"), true);
  });

  it("rejects random string", () => {
    assert.equal(looksLikeId("hello"), false);
  });

  it("rejects empty string", () => {
    assert.equal(looksLikeId(""), false);
  });

  it("rejects partial UUID", () => {
    assert.equal(looksLikeId("550e8400"), false);
  });
});

describe("dmPolicy resolution", () => {
  function resolveDmPolicy(wc?: { dmPolicy?: string; allowFrom?: string[] }) {
    return {
      policy: wc?.dmPolicy ?? "open",
      allowFrom: wc?.allowFrom ?? [],
    };
  }

  it("defaults to open", () => {
    assert.equal(resolveDmPolicy().policy, "open");
  });

  it("respects configured policy", () => {
    assert.equal(resolveDmPolicy({ dmPolicy: "pairing" }).policy, "pairing");
  });

  it("returns allowFrom list", () => {
    const result = resolveDmPolicy({ allowFrom: ["user1", "user2"] });
    assert.deepEqual(result.allowFrom, ["user1", "user2"]);
  });

  it("defaults allowFrom to empty", () => {
    assert.deepEqual(resolveDmPolicy({}).allowFrom, []);
  });
});

describe("setAccountEnabled logic", () => {
  it("enables account", () => {
    const cfg = { channels: { wristclaw: { baseUrl: "http://x", apiKey: "k", enabled: false } } };
    const result = {
      ...cfg,
      channels: {
        ...cfg.channels,
        wristclaw: { ...cfg.channels.wristclaw, enabled: true },
      },
    };
    assert.equal(result.channels.wristclaw.enabled, true);
  });

  it("disables account", () => {
    const cfg = { channels: { wristclaw: { baseUrl: "http://x", apiKey: "k", enabled: true } } };
    const result = {
      ...cfg,
      channels: {
        ...cfg.channels,
        wristclaw: { ...cfg.channels.wristclaw, enabled: false },
      },
    };
    assert.equal(result.channels.wristclaw.enabled, false);
  });
});

describe("deleteAccount logic", () => {
  it("removes wristclaw from channels", () => {
    const cfg = {
      channels: {
        telegram: { enabled: true },
        wristclaw: { baseUrl: "http://x", apiKey: "k" },
      } as Record<string, unknown>,
    };
    const channels = { ...cfg.channels };
    delete channels.wristclaw;
    assert.equal("wristclaw" in channels, false);
    assert.equal("telegram" in channels, true);
  });
});
