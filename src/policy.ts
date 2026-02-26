/**
 * Pure policy / gate functions extracted from monitor.ts for testability.
 * No side effects, no SDK dependencies.
 */

import type { WristClawChannelConfig } from "./types.js";
import { VIA_TAG } from "./constants.js";
import { BoundedMap } from "./bounded-map.js";

// ---------------------------------------------------------------------------
// Echo prevention
// ---------------------------------------------------------------------------

export function isEcho(via: string | undefined, senderId: string, botUserId: string): boolean {
  if (via === VIA_TAG) return true;
  if (botUserId && senderId === botUserId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Cross-account dedup (module-level shared state)
// ---------------------------------------------------------------------------

const CROSS_ACCOUNT_DEDUP_CAP = 2000;
const crossAccountProcessed = new BoundedMap<string, true>(CROSS_ACCOUNT_DEDUP_CAP);

/** Returns true if this is the first claim (proceed). False = duplicate. */
export function crossAccountDedup(msgId: string): boolean {
  if (crossAccountProcessed.has(msgId)) return false;
  crossAccountProcessed.set(msgId, true);
  return true;
}

/** Reset dedup state (for testing). */
export function _resetCrossAccountDedup(): void {
  crossAccountProcessed.clear();
}

// ---------------------------------------------------------------------------
// SSRF protection — media URL validation
// ---------------------------------------------------------------------------

export function isSafeMediaUrl(url: string, serverUrl: string): boolean {
  if (!url) return false;
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    const server = new URL(serverUrl);
    return parsed.hostname === server.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DM / Group access policy gate
// ---------------------------------------------------------------------------

export type PolicyResult = "allow" | "deny" | "record-only";

export function checkDmPolicy(
  config: Pick<WristClawChannelConfig, "dmPolicy" | "allowFrom">,
  senderId: string,
  isOwner: boolean,
): PolicyResult {
  if (isOwner) return "allow";
  const policy = config.dmPolicy ?? "open";
  if (policy === "disabled") return "deny";
  if (policy === "open") return "allow";
  // allowlist
  const allowFrom = config.allowFrom;
  if (!allowFrom?.length) return "deny";
  const isWildcard = allowFrom.some((id) => String(id).trim() === "*");
  if (isWildcard) return "allow";
  if (allowFrom.some((id) => String(id) === senderId)) return "allow";
  return "deny";
}

export function checkGroupPolicy(
  config: Pick<WristClawChannelConfig, "groupPolicy" | "groupAllowFrom">,
  senderId: string,
  isOwner: boolean,
): PolicyResult {
  const policy = config.groupPolicy ?? "mention";
  if (policy === "disabled") return "deny";
  // Check group allowFrom
  const groupAllowFrom = config.groupAllowFrom;
  if (groupAllowFrom?.length) {
    const isWildcard = groupAllowFrom.some((id) => String(id).trim() === "*");
    if (!isWildcard && !isOwner) {
      if (!groupAllowFrom.some((id) => String(id) === senderId)) return "deny";
    }
  }
  if (policy === "open") return "allow";
  // "mention" — caller must check @mention separately
  return "record-only";
}

// ---------------------------------------------------------------------------
// @mention detection + stripping
// ---------------------------------------------------------------------------

export function detectAndStripMention(
  text: string,
  mentionNames: string[],
): { mentioned: boolean; stripped: string } {
  const lower = text.toLowerCase();
  const mentioned = mentionNames.some((name) => lower.includes(`@${name.toLowerCase()}`));
  if (!mentioned) return { mentioned: false, stripped: text };

  let stripped = text;
  for (const name of mentionNames) {
    stripped = stripped.replace(new RegExp(`@${name}\\s*`, "gi"), "");
  }
  stripped = stripped.trim();
  return { mentioned: true, stripped };
}

// ---------------------------------------------------------------------------
// Per-sender rate limiter
// ---------------------------------------------------------------------------

export class SenderRateLimiter {
  private timestamps = new Map<string, number[]>();
  private max: number;
  private windowMs: number;

  constructor(max = 10, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Returns true if rate limited (should drop). */
  isLimited(senderId: string): boolean {
    const now = Date.now();
    let ts = this.timestamps.get(senderId);
    if (!ts) {
      ts = [];
      this.timestamps.set(senderId, ts);
    }
    // Evict expired
    const fresh = ts.filter((t) => now - t < this.windowMs);
    this.timestamps.set(senderId, fresh);
    if (fresh.length >= this.max) return true;
    fresh.push(now);
    return false;
  }

  /** Clean up stale entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.timestamps) {
      const fresh = ts.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.timestamps.delete(id);
      else this.timestamps.set(id, fresh);
    }
  }

  /** Number of tracked senders (for testing). */
  get senderCount(): number {
    return this.timestamps.size;
  }
}

// ---------------------------------------------------------------------------
// API message → WS event conversion (catch-up)
// ---------------------------------------------------------------------------

type APIMessage = {
  message_id: string;
  author_id: string;
  channel_id: string;
  payload?: { content_type?: string; text?: string; media_url?: string; duration_sec?: number; via?: string };
  media_url?: string;
  created_at: string;
  reply_context?: { message_id?: string; author_id?: string; text_preview?: string };
};

export function apiMessageToWSPayload(msg: APIMessage) {
  return {
    message_id: msg.message_id,
    channel_id: msg.channel_id,
    author_id: msg.author_id,
    media_url: msg.media_url,
    created_at: msg.created_at,
    payload: {
      content_type: msg.payload?.content_type,
      text: msg.payload?.text,
      media_url: msg.payload?.media_url,
      duration_sec: msg.payload?.duration_sec,
      via: msg.payload?.via,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve media URL (relative → absolute)
// ---------------------------------------------------------------------------

export function resolveMediaUrl(
  rawUrl: string | undefined,
  serverUrl: string,
): string | undefined {
  if (!rawUrl) return undefined;
  if (rawUrl.startsWith("/")) return `${serverUrl}${rawUrl}`;
  return rawUrl;
}
