/**
 * Unit tests for monitor.ts logic.
 * Tests extracted helper functions and routing decisions.
 * Since processMessage/monitorWristClawProvider depend on OpenClaw SDK,
 * we test the pure logic pieces in isolation.
 */
import { describe, it, expect } from "vitest";

// --------------------------------------------------------------------------
// extractChannelId logic (re-implemented here for unit testing)
// --------------------------------------------------------------------------

function extractChannelId(
  event: { channel?: string; payload?: { channel_id?: string; pair_id?: string } },
  pairToChannel: Map<string, string>,
): string | null {
  if (event.payload?.channel_id) return event.payload.channel_id;
  const pairId = event.payload?.pair_id;
  if (pairId && pairToChannel.has(pairId)) return pairToChannel.get(pairId)!;
  if (event.channel?.startsWith("pair:")) {
    const pid = event.channel.slice(5);
    if (pairToChannel.has(pid)) return pairToChannel.get(pid)!;
  }
  return null;
}

// --------------------------------------------------------------------------
// Owner routing logic (re-implemented for unit testing)
// --------------------------------------------------------------------------

function resolveRouting(
  senderId: string,
  ownerUserId: string | undefined,
  channelId: string,
  secretaryAgentId?: string,
): { agentId: string; peerKind: "direct" | "group"; peerId: string; commandAuthorized: boolean; chatType: "direct" | "group"; sessionKeyPrefix: string } {
  const isOwner = Boolean(ownerUserId && senderId === ownerUserId);
  const defaultAgentId = "dev"; // same agent for both owner and visitors
  const agentId = isOwner ? defaultAgentId : (secretaryAgentId ?? defaultAgentId);
  return {
    agentId,
    peerKind: isOwner ? "direct" : "group",
    peerId: isOwner ? senderId : `ch:${channelId}`,
    commandAuthorized: isOwner,
    chatType: isOwner ? "direct" : "group",
    sessionKeyPrefix: `agent:${agentId}:wristclaw:${isOwner ? "direct" : "group"}:ch:${channelId}`,
  };
}

// --------------------------------------------------------------------------
// Echo prevention logic
// --------------------------------------------------------------------------

function shouldSkipEcho(
  via: string | undefined,
  senderId: string,
  botUserId: string,
): boolean {
  if (via === "openclaw") return true;
  if (botUserId && senderId === botUserId) return true;
  return false;
}

// --------------------------------------------------------------------------
// Voice body resolution logic
// --------------------------------------------------------------------------

function resolveVoiceBody(text: string | undefined): string | null {
  const t = text?.trim();
  if (!t) return null; // skip — wait for voice:transcribed
  return t;
}

// --------------------------------------------------------------------------
// Message author cache logic
// --------------------------------------------------------------------------

function createMessageAuthorCache(cap: number) {
  const map = new Map<string, string>();
  return {
    set(msgId: string, authorId: string) {
      map.set(msgId, authorId);
      if (map.size > cap) {
        const first = map.keys().next().value;
        if (first) map.delete(first);
      }
    },
    get(msgId: string) { return map.get(msgId); },
    get size() { return map.size; },
  };
}

// ==========================================================================
// Tests
// ==========================================================================

describe("extractChannelId", () => {
  const mapping = new Map([
    ["pair-aaa", "ch-111"],
    ["pair-bbb", "ch-222"],
  ]);

  it("uses channel_id from payload directly", () => {
    expect(extractChannelId(
      { payload: { channel_id: "ch-999" } },
      mapping,
    )).toBe("ch-999");
  });

  it("resolves via pair_id mapping", () => {
    expect(extractChannelId(
      { payload: { pair_id: "pair-aaa" } },
      mapping,
    )).toBe("ch-111");
  });

  it("resolves via WS channel field", () => {
    expect(extractChannelId(
      { channel: "pair:pair-bbb" },
      mapping,
    )).toBe("ch-222");
  });

  it("returns null for unknown pair", () => {
    expect(extractChannelId(
      { channel: "pair:unknown" },
      mapping,
    )).toBeNull();
  });

  it("returns null for empty event", () => {
    expect(extractChannelId({}, mapping)).toBeNull();
  });
});

describe("resolveRouting (owner vs visitor)", () => {
  const ownerUserId = "owner-123";
  const channelId = "ch-456";

  it("owner → dev agent + direct per-channel session + authorized", () => {
    const r = resolveRouting("owner-123", ownerUserId, channelId);
    expect(r.agentId).toBe("dev");
    expect(r.peerKind).toBe("direct");
    expect(r.peerId).toBe("owner-123");
    expect(r.commandAuthorized).toBe(true);
    expect(r.chatType).toBe("direct");
    expect(r.sessionKeyPrefix).toBe("agent:dev:wristclaw:direct:ch:ch-456");
  });

  it("visitor → same agent + group session + unauthorized", () => {
    const r = resolveRouting("visitor-789", ownerUserId, channelId);
    expect(r.agentId).toBe("dev");
    expect(r.peerKind).toBe("group");
    expect(r.peerId).toBe("ch:ch-456");
    expect(r.commandAuthorized).toBe(false);
    expect(r.chatType).toBe("group");
    expect(r.sessionKeyPrefix).toBe("agent:dev:wristclaw:group:ch:ch-456");
  });

  it("visitor with custom secretaryAgentId", () => {
    const r = resolveRouting("visitor-789", ownerUserId, channelId, "my-secretary");
    expect(r.agentId).toBe("my-secretary");
    expect(r.sessionKeyPrefix).toBe("agent:my-secretary:wristclaw:group:ch:ch-456");
  });

  it("no ownerUserId configured → all use default agent", () => {
    const r = resolveRouting("anyone", undefined, channelId);
    expect(r.agentId).toBe("dev");
    expect(r.peerKind).toBe("group");
    expect(r.commandAuthorized).toBe(false);
  });

  it("empty senderId → not owner → default agent", () => {
    const r = resolveRouting("", ownerUserId, channelId);
    expect(r.agentId).toBe("dev");
    expect(r.peerKind).toBe("group");
    expect(r.commandAuthorized).toBe(false);
  });
});

describe("echo prevention", () => {
  it("skips via=openclaw", () => {
    expect(shouldSkipEcho("openclaw", "user-1", "bot-1")).toBe(true);
  });

  it("skips when sender is bot", () => {
    expect(shouldSkipEcho(undefined, "bot-1", "bot-1")).toBe(true);
  });

  it("allows normal user message", () => {
    expect(shouldSkipEcho(undefined, "user-1", "bot-1")).toBe(false);
  });

  it("allows when botUserId is empty", () => {
    expect(shouldSkipEcho(undefined, "user-1", "")).toBe(false);
  });
});

describe("voice body resolution", () => {
  it("returns null for empty text (pending transcription)", () => {
    expect(resolveVoiceBody(undefined)).toBeNull();
    expect(resolveVoiceBody("")).toBeNull();
    expect(resolveVoiceBody("  ")).toBeNull();
  });

  it("returns transcribed text when available", () => {
    expect(resolveVoiceBody("Hello world")).toBe("Hello world");
  });

  it("trims whitespace", () => {
    expect(resolveVoiceBody("  trimmed  ")).toBe("trimmed");
  });
});

// --------------------------------------------------------------------------
// Interactive body resolution logic (mirrors monitor.ts)
// --------------------------------------------------------------------------

function resolveInteractiveBody(text: string | undefined): string {
  return text?.trim() || "📋 互動訊息";
}

describe("interactive body resolution", () => {
  it("uses text when provided", () => {
    expect(resolveInteractiveBody("Pick a time:")).toBe("Pick a time:");
  });

  it("falls back to emoji when no text", () => {
    expect(resolveInteractiveBody(undefined)).toBe("📋 互動訊息");
    expect(resolveInteractiveBody("")).toBe("📋 互動訊息");
    expect(resolveInteractiveBody("  ")).toBe("📋 互動訊息");
  });
});

describe("message author cache", () => {
  it("stores and retrieves author_id", () => {
    const cache = createMessageAuthorCache(10);
    cache.set("msg-1", "author-a");
    expect(cache.get("msg-1")).toBe("author-a");
  });

  it("returns undefined for unknown message", () => {
    const cache = createMessageAuthorCache(10);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("evicts oldest when exceeding cap", () => {
    const cache = createMessageAuthorCache(3);
    cache.set("msg-1", "a");
    cache.set("msg-2", "b");
    cache.set("msg-3", "c");
    cache.set("msg-4", "d"); // should evict msg-1

    expect(cache.get("msg-1")).toBeUndefined();
    expect(cache.get("msg-2")).toBe("b");
    expect(cache.get("msg-4")).toBe("d");
    expect(cache.size).toBe(3);
  });
});
