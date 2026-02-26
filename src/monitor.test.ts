/**
 * Unit tests for monitor.ts logic that can't be extracted (SDK-coupled).
 *
 * Pure policy/gate functions are tested in policy.test.ts.
 * Bounded collections are tested in bounded-map.test.ts.
 * VoiceWaiter/MediaGroupBuffer are tested in their own test files.
 *
 * These tests re-implement extractChannelId and resolveRouting to verify
 * the expected behavior (the real functions are inlined in monitor.ts closures).
 */
import { describe, it, expect } from "vitest";

// --------------------------------------------------------------------------
// extractChannelId logic (mirrors monitor.ts — not exportable)
// --------------------------------------------------------------------------

function extractChannelId(
  event: { channel?: string; payload?: { channel_id?: string; pair_id?: string } },
  pairToChannel: Map<string, string>,
): string | null {
  if (event.payload?.channel_id) return event.payload.channel_id;
  const pairId = event.payload?.pair_id;
  if (pairId && pairToChannel.has(pairId)) return pairToChannel.get(pairId)!;
  if (event.channel?.startsWith("channel:")) return event.channel.slice(8);
  return null;
}

// --------------------------------------------------------------------------
// Owner routing logic (mirrors monitor.ts processMessage)
// --------------------------------------------------------------------------

function resolveRouting(
  senderId: string,
  ownerUserId: string | undefined,
  channelId: string,
  accountId: string,
  secretaryAgentId?: string,
) {
  const isOwner = Boolean(ownerUserId && senderId === ownerUserId);
  const defaultAgentId = "dev";
  const agentId = isOwner ? defaultAgentId : (secretaryAgentId ?? defaultAgentId);
  return {
    agentId,
    commandAuthorized: isOwner,
    chatType: isOwner ? "direct" : "group",
    sessionKey: `agent:wristclaw:${accountId}:${isOwner ? "direct" : "group"}:ch:${channelId}`,
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
    expect(extractChannelId({ payload: { channel_id: "ch-999" } }, mapping)).toBe("ch-999");
  });

  it("resolves via pair_id mapping", () => {
    expect(extractChannelId({ payload: { pair_id: "pair-aaa" } }, mapping)).toBe("ch-111");
  });

  it("resolves via WS channel field", () => {
    expect(extractChannelId({ channel: "channel:ch-333" }, mapping)).toBe("ch-333");
  });

  it("returns null for unknown pair", () => {
    expect(extractChannelId({ payload: { pair_id: "unknown" } }, mapping)).toBeNull();
  });

  it("returns null for empty event", () => {
    expect(extractChannelId({}, mapping)).toBeNull();
  });
});

describe("resolveRouting", () => {
  const ownerUserId = "owner-123";
  const channelId = "ch-456";

  it("owner → dev agent + direct session + authorized", () => {
    const r = resolveRouting("owner-123", ownerUserId, channelId, "alpha");
    expect(r.agentId).toBe("dev");
    expect(r.commandAuthorized).toBe(true);
    expect(r.chatType).toBe("direct");
    expect(r.sessionKey).toBe("agent:wristclaw:alpha:direct:ch:ch-456");
  });

  it("visitor → dev agent + group session + unauthorized", () => {
    const r = resolveRouting("visitor-789", ownerUserId, channelId, "alpha");
    expect(r.agentId).toBe("dev");
    expect(r.commandAuthorized).toBe(false);
    expect(r.chatType).toBe("group");
    expect(r.sessionKey).toBe("agent:wristclaw:alpha:group:ch:ch-456");
  });

  it("visitor with secretaryAgentId", () => {
    const r = resolveRouting("visitor", ownerUserId, channelId, "beta", "secretary");
    expect(r.agentId).toBe("secretary");
    expect(r.sessionKey).toBe("agent:wristclaw:beta:group:ch:ch-456");
  });

  it("no ownerUserId → all visitors", () => {
    const r = resolveRouting("anyone", undefined, channelId, "alpha");
    expect(r.commandAuthorized).toBe(false);
    expect(r.chatType).toBe("group");
  });
});
