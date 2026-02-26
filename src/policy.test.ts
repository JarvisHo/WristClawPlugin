import { describe, it, expect, beforeEach } from "vitest";
import {
  isEcho,
  crossAccountDedup,
  _resetCrossAccountDedup,
  isSafeMediaUrl,
  checkDmPolicy,
  checkGroupPolicy,
  detectAndStripMention,
  SenderRateLimiter,
  apiMessageToWSPayload,
  resolveMediaUrl,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Echo prevention
// ---------------------------------------------------------------------------

describe("isEcho", () => {
  it("true for via=openclaw", () => {
    expect(isEcho("openclaw", "user1", "bot1")).toBe(true);
  });
  it("true when sender is bot", () => {
    expect(isEcho(undefined, "bot1", "bot1")).toBe(true);
  });
  it("false for normal user", () => {
    expect(isEcho(undefined, "user1", "bot1")).toBe(false);
  });
  it("false when botUserId empty", () => {
    expect(isEcho(undefined, "user1", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-account dedup
// ---------------------------------------------------------------------------

describe("crossAccountDedup", () => {
  beforeEach(() => _resetCrossAccountDedup());

  it("first claim returns true", () => {
    expect(crossAccountDedup("msg1")).toBe(true);
  });
  it("second claim returns false", () => {
    crossAccountDedup("msg1");
    expect(crossAccountDedup("msg1")).toBe(false);
  });
  it("different messages both return true", () => {
    expect(crossAccountDedup("a")).toBe(true);
    expect(crossAccountDedup("b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

describe("isSafeMediaUrl", () => {
  const server = "https://api.badm.in";

  it("allows relative path", () => {
    expect(isSafeMediaUrl("/media/image.jpg", server)).toBe(true);
  });
  it("allows same-origin URL", () => {
    expect(isSafeMediaUrl("https://api.badm.in/media/img.jpg", server)).toBe(true);
  });
  it("blocks cross-origin URL", () => {
    expect(isSafeMediaUrl("https://evil.com/steal", server)).toBe(false);
  });
  it("blocks empty URL", () => {
    expect(isSafeMediaUrl("", server)).toBe(false);
  });
  it("blocks invalid URL", () => {
    expect(isSafeMediaUrl("not-a-url", server)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DM policy
// ---------------------------------------------------------------------------

describe("checkDmPolicy", () => {
  it("owner always allowed", () => {
    expect(checkDmPolicy({ dmPolicy: "disabled" }, "owner", true)).toBe("allow");
  });
  it("open allows anyone", () => {
    expect(checkDmPolicy({ dmPolicy: "open" }, "stranger", false)).toBe("allow");
  });
  it("disabled blocks non-owner", () => {
    expect(checkDmPolicy({ dmPolicy: "disabled" }, "user", false)).toBe("deny");
  });
  it("allowlist allows listed user", () => {
    expect(checkDmPolicy({ dmPolicy: "allowlist", allowFrom: ["user1"] }, "user1", false)).toBe("allow");
  });
  it("allowlist blocks unlisted user", () => {
    expect(checkDmPolicy({ dmPolicy: "allowlist", allowFrom: ["user1"] }, "user2", false)).toBe("deny");
  });
  it("allowlist with wildcard allows anyone", () => {
    expect(checkDmPolicy({ dmPolicy: "allowlist", allowFrom: ["*"] }, "anyone", false)).toBe("allow");
  });
  it("allowlist with empty list blocks all", () => {
    expect(checkDmPolicy({ dmPolicy: "allowlist", allowFrom: [] }, "user", false)).toBe("deny");
  });
  it("default (undefined) = open", () => {
    expect(checkDmPolicy({}, "user", false)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Group policy
// ---------------------------------------------------------------------------

describe("checkGroupPolicy", () => {
  it("disabled blocks all", () => {
    expect(checkGroupPolicy({ groupPolicy: "disabled" }, "user", false)).toBe("deny");
  });
  it("open allows all", () => {
    expect(checkGroupPolicy({ groupPolicy: "open" }, "user", false)).toBe("allow");
  });
  it("mention returns record-only (caller checks @mention)", () => {
    expect(checkGroupPolicy({ groupPolicy: "mention" }, "user", false)).toBe("record-only");
  });
  it("groupAllowFrom blocks unlisted non-owner", () => {
    expect(checkGroupPolicy({ groupPolicy: "open", groupAllowFrom: ["vip"] }, "user", false)).toBe("deny");
  });
  it("groupAllowFrom allows listed user", () => {
    expect(checkGroupPolicy({ groupPolicy: "open", groupAllowFrom: ["vip"] }, "vip", false)).toBe("allow");
  });
  it("groupAllowFrom wildcard allows all", () => {
    expect(checkGroupPolicy({ groupPolicy: "open", groupAllowFrom: ["*"] }, "anyone", false)).toBe("allow");
  });
  it("owner bypasses groupAllowFrom", () => {
    expect(checkGroupPolicy({ groupPolicy: "open", groupAllowFrom: ["vip"] }, "owner", true)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// @mention detection + stripping
// ---------------------------------------------------------------------------

describe("detectAndStripMention", () => {
  it("detects @mention and strips it", () => {
    const result = detectAndStripMention("@bot hello", ["bot"]);
    expect(result.mentioned).toBe(true);
    expect(result.stripped).toBe("hello");
  });
  it("case insensitive", () => {
    const result = detectAndStripMention("@BOT hi", ["bot"]);
    expect(result.mentioned).toBe(true);
    expect(result.stripped).toBe("hi");
  });
  it("not mentioned = record-only", () => {
    const result = detectAndStripMention("hello world", ["bot"]);
    expect(result.mentioned).toBe(false);
    expect(result.stripped).toBe("hello world");
  });
  it("strips multiple mention names", () => {
    const result = detectAndStripMention("@bot @all hey", ["bot", "all"]);
    expect(result.mentioned).toBe(true);
    expect(result.stripped).toBe("hey");
  });
  it("returns empty after stripping if only mention", () => {
    const result = detectAndStripMention("@bot", ["bot"]);
    expect(result.mentioned).toBe(true);
    expect(result.stripped).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Per-sender rate limiter
// ---------------------------------------------------------------------------

describe("SenderRateLimiter", () => {
  it("allows under limit", () => {
    const rl = new SenderRateLimiter(3, 60_000);
    expect(rl.isLimited("u1")).toBe(false);
    expect(rl.isLimited("u1")).toBe(false);
    expect(rl.isLimited("u1")).toBe(false);
  });
  it("blocks at limit", () => {
    const rl = new SenderRateLimiter(2, 60_000);
    rl.isLimited("u1");
    rl.isLimited("u1");
    expect(rl.isLimited("u1")).toBe(true);
  });
  it("different senders are independent", () => {
    const rl = new SenderRateLimiter(1, 60_000);
    expect(rl.isLimited("u1")).toBe(false);
    expect(rl.isLimited("u2")).toBe(false);
    expect(rl.isLimited("u1")).toBe(true);
  });
  it("cleanup removes stale entries", () => {
    const rl = new SenderRateLimiter(10, 1); // 1ms window
    rl.isLimited("u1");
    // Wait tiny bit for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // spin
    rl.cleanup();
    expect(rl.senderCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// API message → WS payload
// ---------------------------------------------------------------------------

describe("apiMessageToWSPayload", () => {
  it("converts API message format", () => {
    const result = apiMessageToWSPayload({
      message_id: "123",
      author_id: "user1",
      channel_id: "ch1",
      payload: { content_type: "text", text: "hello", via: "app" },
      media_url: "https://cdn/img.jpg",
      created_at: "2026-02-25T10:00:00Z",
    });
    expect(result.message_id).toBe("123");
    expect(result.channel_id).toBe("ch1");
    expect(result.payload?.text).toBe("hello");
    expect(result.payload?.via).toBe("app");
    expect(result.media_url).toBe("https://cdn/img.jpg");
  });
  it("handles missing payload fields", () => {
    const result = apiMessageToWSPayload({
      message_id: "456",
      author_id: "u",
      channel_id: "c",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(result.payload?.content_type).toBeUndefined();
    expect(result.media_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveMediaUrl
// ---------------------------------------------------------------------------

describe("resolveMediaUrl", () => {
  it("resolves relative to server", () => {
    expect(resolveMediaUrl("/media/img.jpg", "https://api.badm.in")).toBe("https://api.badm.in/media/img.jpg");
  });
  it("returns absolute URL as-is", () => {
    expect(resolveMediaUrl("https://cdn.com/img.jpg", "https://api.badm.in")).toBe("https://cdn.com/img.jpg");
  });
  it("returns undefined for undefined", () => {
    expect(resolveMediaUrl(undefined, "https://api.badm.in")).toBeUndefined();
  });
});
