import { WebSocket } from "ws";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  recordPendingHistoryEntryIfEnabled,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount, WristClawPair, WristClawConversation } from "./types.js";
import { getWristClawRuntime } from "./runtime.js";
import { sendMessageWristClaw, authHeaders } from "./send.js";
import { fetchWithRetry } from "./fetch-utils.js";

type PluginRuntimeType = ReturnType<typeof getWristClawRuntime>;

export type WristClawMonitorOptions = {
  account: ResolvedWristClawAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

// ---------------------------------------------------------------------------
// WS event types (discriminated union)
// ---------------------------------------------------------------------------

/** Nested message content inside WS broadcast */
type WSMessageContent = {
  content_type?: string;
  text?: string;
  media_url?: string;
  duration_sec?: number;
  via?: string;
};

/** Reply context included in message:new broadcast */
type WSReplyTo = {
  message_id?: string;
  author_id?: string;
  text_preview?: string;
  quote_text?: string;
};

/** message:new payload from OutboxProcessor */
type WSMessagePayload = {
  pair_id?: string;
  author_id?: string;
  sender_name?: string;
  channel_id?: string;
  message_id?: string;
  created_at?: string;
  media_url?: string;
  reply_to?: WSReplyTo;
  payload?: WSMessageContent;
};

/** voice:transcribed payload (legacy, kept for WSEvent union compat) */
type WSVoiceTranscribedPayload = {
  pair_id?: string;
  message_id?: string;
  channel_id?: string;
  author_id?: string;
  text?: string;
  language?: string;
};

/** pair:created payload */
type WSPairCreatedPayload = {
  pair_id?: string;
};

/** group:member_added payload (sent to user:{userId} channel) */
type WSGroupMemberAddedPayload = {
  channel_id?: string;
  group_name?: string;
};

type WSEvent =
  | { type: "authenticated" }
  | { type: "pong" }
  | { type: "subscribed"; channel?: string }
  | { type: "message:new"; channel?: string; payload?: WSMessagePayload }
  | { type: "voice:transcribed"; channel?: string; payload?: WSVoiceTranscribedPayload }
  | { type: "message:update"; channel?: string; payload?: { message_id?: string; channel_id?: string; author_id?: string; text?: string; language?: string } }
  | { type: "pair:created"; channel?: string; payload?: WSPairCreatedPayload }
  | { type: "group:member_added"; channel?: string; payload?: WSGroupMemberAddedPayload }
  | { type: "group:member_changed"; channel?: string; payload?: unknown }
  | { type: "error"; payload?: { message?: string } };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max text length per outbound message chunk */
const TEXT_LIMIT = 4000;
/** Max cached message→author mappings */
const MESSAGE_AUTHOR_CAP = 500;
/** Max tracked processed message IDs (dedup WS + catch-up overlap) */
const DEDUP_CAP = 1000;
/** Max simultaneous AI dispatch coroutines */
const MAX_CONCURRENT = 3;
/** Per-sender rate limit: max messages within window */
const RATE_LIMIT_MAX = 10;
/** Per-sender rate limit: sliding window duration (ms) */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Rate limit map cleanup interval (ms) */
const RATE_LIMIT_CLEANUP_MS = 300_000;
/** Cross-account dedup: shared across all account monitors to prevent
 *  duplicate AI dispatch when multiple accounts see the same channel. */
const CROSS_ACCOUNT_DEDUP_CAP = 2000;
const crossAccountProcessed = new Map<string, number>(); // messageId → timestamp

function crossAccountDedup(msgId: string): boolean {
  if (crossAccountProcessed.has(msgId)) return false; // already claimed
  crossAccountProcessed.set(msgId, Date.now());
  // Evict old entries
  if (crossAccountProcessed.size > CROSS_ACCOUNT_DEDUP_CAP) {
    const cutoff = Date.now() - 300_000; // 5 min
    for (const [id, ts] of crossAccountProcessed) {
      if (ts < cutoff) crossAccountProcessed.delete(id);
    }
  }
  return true; // first claim
}

/** WS keepalive ping interval (ms) */
const PING_INTERVAL_MS = 30_000;
/** WS pong response timeout — force reconnect if exceeded (ms) */
const PONG_TIMEOUT_MS = 10_000;
/** Max reconnect backoff (ms) */
const MAX_BACKOFF_MS = 60_000;
/** Typing indicator heartbeat interval (ms) */
const TYPING_HEARTBEAT_MS = 3_500;

// ---------------------------------------------------------------------------
// Pair list fetch
// ---------------------------------------------------------------------------

type BotIdentity = { userId: string; displayName: string };

async function fetchBotIdentity(account: ResolvedWristClawAccount): Promise<BotIdentity> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/me`, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`/me failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    userId: data.user_id ?? "",
    displayName: data.display_name ?? "",
  };
}

async function fetchPairList(account: ResolvedWristClawAccount): Promise<WristClawPair[]> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/pair/list`, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`pair/list failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.pairs ?? [];
}

async function fetchConversations(account: ResolvedWristClawAccount): Promise<WristClawConversation[]> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/conversations`, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`conversations failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.conversations ?? [];
}

// ---------------------------------------------------------------------------
// Catch-up: fetch missed messages after reconnect
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

async function fetchMissedMessages(
  channelId: string,
  afterMessageId: string,
  account: ResolvedWristClawAccount,
): Promise<APIMessage[]> {
  if (!/^[\w-]+$/.test(channelId)) return [];
  if (!/^[\w-]+$/.test(afterMessageId)) return [];
  const url = `${account.serverUrl}/v1/channels/${channelId}/messages?after=${afterMessageId}&limit=50`;
  const res = await fetchWithRetry(url, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? [];
}

function apiMessageToWSEvent(msg: APIMessage, wsChannel: string): WSEvent & { type: "message:new" } {
  return {
    type: "message:new" as const,
    channel: wsChannel,
    payload: {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Process inbound message (follows zalouser pattern)
// ---------------------------------------------------------------------------

type ProcessMessageCtx = {
  event: WSEvent & { type: "message:new" };
  channelId: string;
  wsChannel: string;
  ws: WebSocket | null;
  botUserId: string;
  botDisplayName: string;
  isGroupChannel: boolean;
  account: ResolvedWristClawAccount;
  config: OpenClawConfig;
  core: PluginRuntimeType;
  runtime: RuntimeEnv;
  statusSink?: WristClawMonitorOptions["statusSink"];
  rateLimitCheck?: (senderId: string) => boolean;
  dedupCheck?: (msgId: string) => boolean;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  /** Additional image URLs for media group (first image is in event payload) */
  extraMediaUrls?: string[];
  /** Wait for voice transcription (defined in monitor closure) */
  waitForTranscription?: (messageId: string) => Promise<string>;
};

/** Validate that a media URL is safe to fetch (same origin as server, or relative) */
function isSafeMediaUrl(url: string, serverUrl: string): boolean {
  if (!url) return false;
  // Relative paths are always safe (resolved to server origin)
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    const server = new URL(serverUrl);
    // Only allow same hostname as the configured server
    return parsed.hostname === server.hostname;
  } catch {
    return false;
  }
}

async function processMessage(ctx: ProcessMessageCtx): Promise<void> {
  const { event, channelId, wsChannel, ws, botUserId, botDisplayName, isGroupChannel, account, config, core, runtime, statusSink, rateLimitCheck, dedupCheck } = ctx;
  const raw = event.payload;
  if (!raw) return;

  const nested = raw.payload;
  const via = nested?.via;
  const contentType = nested?.content_type ?? "text";
  const text = nested?.text;
  const rawMediaUrl = nested?.media_url ?? raw.media_url;
  // Resolve relative media URLs (server may return /media/... paths)
  const mediaUrl = rawMediaUrl && rawMediaUrl.startsWith("/")
    ? `${account.config.baseUrl ?? account.config.serverUrl ?? ""}${rawMediaUrl}`
    : rawMediaUrl;
  const senderId = raw.author_id ?? "";
  // WS broadcast now includes sender_name (resolved by OutboxProcessor)
  const senderName = raw.sender_name ?? "";

  // === Echo prevention (double check: via field + sender_id) ===
  if (via === "openclaw") return;
  if (botUserId && senderId === botUserId) return;

  // === Cross-account dedup (prevents double reply when multiple accounts see same channel) ===
  const msgId = raw.message_id;
  if (msgId && !crossAccountDedup(msgId)) return;

  // === Per-account dedup check (WS reconnect catch-up overlap) ===
  if (msgId && dedupCheck && !dedupCheck(msgId)) return;

  // === Access policy gate (DM vs Group, modeled after Telegram plugin) ===
  const isOwnerSender = Boolean(account.ownerUserId && senderId === account.ownerUserId);

  if (ctx.isGroupChannel) {
    // --- Group policy ---
    const groupPolicy = account.config.groupPolicy ?? "mention";
    if (groupPolicy === "disabled") return;

    // Group allowFrom: optional per-group sender filter
    const groupAllowFrom = account.config.groupAllowFrom;
    if (groupAllowFrom?.length) {
      const isWildcard = groupAllowFrom.some((id) => String(id).trim() === "*");
      if (!isWildcard && !isOwnerSender) {
        if (!groupAllowFrom.some((id) => String(id) === senderId)) return;
      }
    }
  } else {
    // --- DM policy ---
    const dmPolicy = account.config.dmPolicy ?? "open";
    if (dmPolicy === "disabled" && !isOwnerSender) return;
    if (dmPolicy === "allowlist" && !isOwnerSender) {
      const allowFrom = account.config.allowFrom;
      if (!allowFrom?.length) return; // no allowlist entries = block all
      const isWildcard = allowFrom.some((id) => String(id).trim() === "*");
      if (!isWildcard && !allowFrom.some((id) => String(id) === senderId)) return;
    }
  }

  // === Per-sender rate limit (injected via closure) ===
  if (rateLimitCheck && senderId && rateLimitCheck(senderId)) return;

  // Build body from content type
  let rawBody: string;
  if (contentType === "text") {
    rawBody = text?.trim() ?? "";
  } else if (contentType === "voice") {
    let t = text?.trim();
    if (!t) {
      // No transcription yet — wait for message:update from server
      const msgId = raw.message_id;
      if (msgId) {
        runtime.log(`[wristclaw] voice message ${msgId}: waiting for transcription...`);
        t = ctx.waitForTranscription ? (await ctx.waitForTranscription(msgId)).trim() : "";
      }
    }
    rawBody = t || "🎤 語音訊息";
  } else if (contentType === "image") {
    const imageCount = 1 + (ctx.extraMediaUrls?.length ?? 0);
    rawBody = text?.trim() || (imageCount > 1 ? `📷 ${imageCount} 張圖片` : "📷 圖片");
  } else if (contentType === "interactive") {
    rawBody = text?.trim() || "📋 互動訊息";
  } else {
    rawBody = text?.trim() ?? "";
  }

  if (!rawBody) return;

  // === Download image(s) to local storage for vision model ===
  let imageMediaPaths: string[] = [];
  if (contentType === "image") {
    runtime.log(`[wristclaw] image msg: mediaUrl=${mediaUrl}, rawMediaUrl=${nested?.media_url ?? raw.media_url}, raw keys=${Object.keys(raw ?? {})}, nested keys=${Object.keys(nested ?? {})}`);
  }
  if (contentType === "image" && mediaUrl) {
    const allUrls = [mediaUrl, ...(ctx.extraMediaUrls ?? [])].filter(
      (u) => isSafeMediaUrl(u, account.serverUrl),
    );
    if (allUrls.length === 0 && mediaUrl) {
      runtime.error(`[wristclaw] SSRF blocked: media URL not same-origin: ${mediaUrl.slice(0, 100)}`);
    }
    const downloadResults = await Promise.allSettled(
      allUrls.map(async (url) => {
        try {
          const fetched = await core.channel.media.fetchRemoteMedia({ url, maxBytes: 10 * 1024 * 1024 });
          const saved = await core.channel.media.saveMediaBuffer(fetched.buffer, fetched.contentType ?? "image/jpeg", "inbound");
          return saved.path;
        } catch (err) {
          runtime.error(`[wristclaw] image download failed: ${String(err)}`);
          return null;
        }
      })
    );
    imageMediaPaths = downloadResults
      .map(r => r.status === "fulfilled" ? r.value : null)
      .filter((p): p is string => p !== null);
  }

  // === Group history + @mention gate ===
  const historyKey = ctx.isGroupChannel ? channelId : "";
  const { historyLimit, groupHistories } = ctx;

  if (ctx.isGroupChannel) {
    const groupPolicy = account.config.groupPolicy ?? "mention";

    // Build sender label for history (use senderId as fallback)
    const senderLabel = senderName || `user:${senderId.slice(0, 8)}`;

    if (groupPolicy === "mention") {
      // Resolve mention names for @mention detection
      const mentionNames: string[] = [];
      const cfgMention = account.config.mentionNames;
      if (Array.isArray(cfgMention)) {
        for (const n of cfgMention) if (typeof n === "string" && n) mentionNames.push(n.toLowerCase());
      }
      if (ctx.botDisplayName) {
        const bn = ctx.botDisplayName.toLowerCase();
        if (!mentionNames.includes(bn)) mentionNames.push(bn);
      }
      mentionNames.push("all");

      const rawText = rawBody.toLowerCase();
      const isMentioned = mentionNames.some(name => rawText.includes(`@${name}`));

      if (!isMentioned) {
        // Not mentioned → record to history and return (don't dispatch to AI)
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: historyLimit,
          entry: historyKey ? {
            sender: senderLabel,
            body: rawBody,
            timestamp: raw.created_at ? new Date(raw.created_at).getTime() : Date.now(),
            messageId: raw.message_id,
          } : null,
        });
        return;
      }

      // Mentioned → strip @mention from rawBody
      for (const name of mentionNames) {
        rawBody = rawBody.replace(new RegExp(`@${name}\\s*`, "gi"), "");
      }
      rawBody = rawBody.trim();
      if (!rawBody) return;
    }
    // groupPolicy="open": fall through (no mention check, no history needed)
  }

  // === Parse reply context for AI ===
  const replyTo = raw.reply_to;
  const replyQuoteText = replyTo?.text_preview || "";
  if (replyQuoteText) {
    // Truncate + sanitize: strip control chars, mark as user-quoted content
    const sanitized = replyQuoteText.slice(0, 100).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    rawBody = `[回覆 (user-quoted-content)：「${sanitized}」]\n${rawBody}`;
  }

  // === Resolve agent route ===
  // Both owner and visitors get per-channel isolated sessions (no main session pollution)
  const isOwner = isOwnerSender;

  const baseRoute = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wristclaw",
    accountId: account.accountId,
    peer: { kind: "direct" as const, id: senderId },
  });

  const agentId = isOwner
    ? baseRoute.agentId
    : (account.config.secretaryAgentId ?? baseRoute.agentId);

  // All WristClaw users get per-channel sessions (owner included)
  // Session key uses fixed "wristclaw" prefix (not agentId) for stable keys across routing changes
  const route = {
    agentId,
    sessionKey: account.accountId === "default"
      ? `agent:wristclaw:${isOwner ? "direct" : "group"}:ch:${channelId}`
      : `agent:wristclaw:${account.accountId}:${isOwner ? "direct" : "group"}:ch:${channelId}`,
    accountId: account.accountId,
  };

  // === Build inbound context ===
  const storePath = core.channel.session.resolveStorePath(
    // SDK doesn't expose session.store type — cast required
    (config.session as { store?: string } | undefined)?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const fromLabel = senderName || `user:${senderId}`;
  const envelope = core.channel.reply.formatAgentEnvelope({
    channel: "WristClaw",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // === Build combined body with group chat history ===
  let combinedBody = envelope;
  let inboundHistory: HistoryEntry[] | undefined;
  if (ctx.isGroupChannel && historyKey && historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: groupHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) => {
        const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "";
        return `[${ts}] ${entry.sender}: ${entry.body}`;
      },
    });
    inboundHistory = (groupHistories.get(historyKey) ?? []).map((entry) => ({
      sender: entry.sender,
      body: entry.body,
      timestamp: entry.timestamp,
    }));
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: rawBody,
    CommandAuthorized: isOwner,
    From: `wristclaw:${senderId}`,
    To: `wristclaw:${channelId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isOwner ? "direct" : "group",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: "wristclaw",
    Surface: "wristclaw",
    MessageSid: raw.message_id ?? `${Date.now()}`,
    ReplyToId: replyTo?.message_id,
    ReplyToBody: replyQuoteText || undefined,
    ReplyToSender: replyTo?.author_id,
    OriginatingChannel: "wristclaw" as const,
    OriginatingTo: `wristclaw:${channelId}`,
    // Image: pass local media path(s) for vision model (matches Telegram plugin pattern)
    ...(imageMediaPaths.length > 1
      ? {
          MediaPath: imageMediaPaths[0], MediaUrl: imageMediaPaths[0], MediaType: "image",
          MediaPaths: imageMediaPaths, MediaUrls: imageMediaPaths,
          MediaTypes: imageMediaPaths.map(() => "image"),
        }
      : imageMediaPaths.length === 1
        ? { MediaPath: imageMediaPaths[0], MediaUrl: imageMediaPaths[0], MediaType: "image" }
        : {}),
  });

  // === Record session ===
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      runtime.error(`[wristclaw] session meta error: ${String(err)}`);
    },
  });

  // === Dispatch to AI agent → reply via deliver callback ===
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "wristclaw",
    accountId: account.accountId,
  });

  // === Send typing indicator via WS ===
  const sendTypingStatus = (status: "thinking" | "typing" | "stopped" = "typing") => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "typing",
          channel: wsChannel,
          payload: { status },
        }));
      }
    } catch { /* ignore closed socket */ }
  };

  // Start with "thinking" status while AI processes, heartbeat every 3.5s
  sendTypingStatus("thinking");
  let currentTypingStatus: "thinking" | "typing" = "thinking";
  const typingInterval = setInterval(() => sendTypingStatus(currentTypingStatus), TYPING_HEARTBEAT_MS);

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (replyPayload) => {
          // Switch to "typing" status when first chunk is ready, then stop interval
          if (currentTypingStatus === "thinking") {
            currentTypingStatus = "typing";
            sendTypingStatus("typing");
          }
          clearInterval(typingInterval);

          const text = core.channel.text.convertMarkdownTables(
            // SDK deliver callback payload type is opaque — cast required
            (replyPayload as { text?: string }).text ?? "",
            "code",
          );
          if (!text) return;

          const chunkMode = core.channel.text.resolveChunkMode(
            config,
            "wristclaw",
            account.accountId,
          );
          const chunks = core.channel.text.chunkMarkdownTextWithMode(
            text,
            TEXT_LIMIT,
            chunkMode,
          );

          for (const chunk of chunks) {
            const result = await sendMessageWristClaw(channelId, chunk, {
              serverUrl: account.serverUrl,
              apiKey: account.apiKey,
            });
            if (!result.ok) {
              runtime.error(`[wristclaw] send failed: ${result.error}`);
            }
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        },
        onError: (err, info) => {
          runtime.error(`[wristclaw] ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyOptions: { onModelSelected },
    });
  } finally {
    clearInterval(typingInterval);
    // Clear group history after reply (same as Telegram: history is consumed)
    if (ctx.isGroupChannel && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Extract channel ID from WS event
// ---------------------------------------------------------------------------

function extractChannelId(
  event: WSEvent & { type: "message:new" },
  pairToChannel: Map<string, string>,
): string | null {
  const payload = event.payload;
  // Server WS broadcast includes channel_id directly
  if (payload?.channel_id) {
    return payload.channel_id;
  }
  // Try pair_id → channel_id mapping
  const pairId = payload?.pair_id;
  if (pairId && pairToChannel.has(pairId)) {
    return pairToChannel.get(pairId)!;
  }
  // From WS channel field: "channel:<channelId>"
  if (event.channel?.startsWith("channel:")) {
    return event.channel.slice(8);
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebSocket monitor with reconnect
// ---------------------------------------------------------------------------

/**
 * Start monitoring all WristClaw pairs via WebSocket.
 * Handles auth, pair subscription, inbound dispatch, catch-up on reconnect,
 * typing indicators, rate limiting, and graceful shutdown.
 */
export async function monitorWristClawProvider(
  options: WristClawMonitorOptions,
): Promise<{ stop: () => void }> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getWristClawRuntime();

  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let resolveRunning: (() => void) | null = null;

  // pair_id → channel_id mapping
  const pairToChannel = new Map<string, string>();
  // channel_id → last seen message_id (for reconnect catch-up)
  const lastSeenMessageId = new Map<string, string>();
  // message_id → author_id cache (for catch-up and dedup)
  const messageAuthorMap = new Map<string, string>();
  const processedMessageIds = new Set<string>();
  // Group chat history: channel_id → recent messages (for @mention context)
  const groupHistories = new Map<string, HistoryEntry[]>();
  const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  let activeDispatches = 0;

  // --- Media group buffer: batch rapid image messages from same sender ---
  const MEDIA_GROUP_DELAY_MS = 800;
  type WSMessageNewEvent = WSEvent & { type: "message:new" };
  type MediaGroupEntry = {
    event: WSMessageNewEvent;
    channelId: string;
    wsChannel: string;
    extraMediaUrls: string[];
    timer: ReturnType<typeof setTimeout>;
  };
  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

  function flushMediaGroup(key: string) {
    const entry = mediaGroupBuffer.get(key);
    if (!entry) return;
    mediaGroupBuffer.delete(key);

    if (activeDispatches >= MAX_CONCURRENT) {
      runtime.log(`[wristclaw] dropping media group: ${activeDispatches} dispatches active`);
      return;
    }
    activeDispatches++;
    processMessage({
      event: entry.event, channelId: entry.channelId, wsChannel: entry.wsChannel, ws, botUserId, botDisplayName,
      isGroupChannel: groupChannelIds.has(entry.channelId), account, config, core, runtime, statusSink,
      rateLimitCheck: isRateLimited, dedupCheck: markProcessed, groupHistories, historyLimit,
      extraMediaUrls: entry.extraMediaUrls.length > 0 ? entry.extraMediaUrls : undefined,
      waitForTranscription,
    })
      .catch((err) => runtime.error(`[wristclaw] process error: ${String(err)}`))
      .finally(() => { activeDispatches--; });
  }

  function bufferOrFlushImage(msg: WSMessageNewEvent, channelId: string, wsChannel: string): boolean {
    const nested = msg.payload?.payload;
    const contentType = nested?.content_type ?? "text";
    if (contentType !== "image") {
      // Non-image message from same sender: flush any buffered group immediately
      const senderId = msg.payload?.author_id ?? "";
      const key = `${channelId}:${senderId}`;
      if (mediaGroupBuffer.has(key)) {
        clearTimeout(mediaGroupBuffer.get(key)!.timer);
        flushMediaGroup(key);
      }
      return false; // not buffered, let caller handle normally
    }

    const senderId = msg.payload?.author_id ?? "";
    const rawUrl = nested?.media_url ?? msg.payload?.media_url;
    const mediaUrl = rawUrl && rawUrl.startsWith("/")
      ? `${account.config.baseUrl ?? account.config.serverUrl ?? ""}${rawUrl}`
      : rawUrl;
    const key = `${channelId}:${senderId}`;

    const existing = mediaGroupBuffer.get(key);
    if (existing) {
      // Add to existing group
      clearTimeout(existing.timer);
      if (mediaUrl) existing.extraMediaUrls.push(mediaUrl);
      existing.timer = setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_DELAY_MS);
    } else {
      // Start new group — first image becomes the "primary" event
      const timer = setTimeout(() => flushMediaGroup(key), MEDIA_GROUP_DELAY_MS);
      mediaGroupBuffer.set(key, {
        event: msg,
        channelId,
        wsChannel,
        extraMediaUrls: [],
        timer,
      });
    }
    return true; // buffered
  }
  // --- Voice transcription waiter: wait for message:update before dispatching ---
  const VOICE_WAIT_MS = 15_000;
  type VoiceWaiter = {
    resolve: (text: string) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const voiceWaiters = new Map<string, VoiceWaiter>();

  /** Wait for transcription text via message:update. Returns text or empty string on timeout. */
  function waitForTranscription(messageId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        voiceWaiters.delete(messageId);
        resolve(""); // timeout — no transcription
      }, VOICE_WAIT_MS);
      voiceWaiters.set(messageId, { resolve, timer });
    });
  }

  /** Called when message:update arrives — resolves the waiter if any. */
  function resolveVoiceWaiter(messageId: string, text: string): boolean {
    const waiter = voiceWaiters.get(messageId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    voiceWaiters.delete(messageId);
    waiter.resolve(text);
    return true;
  }

  const senderTimestamps = new Map<string, number[]>();

  function isRateLimited(senderId: string): boolean {
    const now = Date.now();
    let timestamps = senderTimestamps.get(senderId);
    if (!timestamps) {
      timestamps = [];
      senderTimestamps.set(senderId, timestamps);
    }
    // Evict old entries
    timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    senderTimestamps.set(senderId, timestamps);
    if (timestamps.length >= RATE_LIMIT_MAX) return true;
    timestamps.push(now);
    return false;
  }

  // Periodic cleanup of stale sender entries (every 5 min)
  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of senderTimestamps) {
      const fresh = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) senderTimestamps.delete(id);
      else senderTimestamps.set(id, fresh);
    }
  }, RATE_LIMIT_CLEANUP_MS);

  function markProcessed(msgId: string): boolean {
    if (processedMessageIds.has(msgId)) return false; // already processed
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > DEDUP_CAP) {
      // Evict oldest ~20%
      const iter = processedMessageIds.values();
      for (let i = 0; i < DEDUP_CAP * 0.2; i++) {
        const v = iter.next().value;
        if (v) processedMessageIds.delete(v);
      }
    }
    return true; // first time
  }

  let botUserId = "";
  let botDisplayName = "";
  const groupChannelIds = new Set<string>();
  let isFirstConnect = true;

  const connect = () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    const wsUrl = account.serverUrl.replace(/^http/, "ws") + "/v1/ws";

    // Block non-TLS to remote host (API key would be sent in cleartext)
    if (wsUrl.startsWith("ws://") && !/localhost|127\.0\.0\.1|\[::1\]/.test(wsUrl)) {
      runtime.error(`[wristclaw] BLOCKED: refusing ws:// to remote host — use https/wss to protect API key. URL: ${wsUrl}`);
      resolveRunning?.();
      return;
    }

    runtime.log(`[wristclaw] connecting to ${wsUrl}`);

    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      runtime.log("[wristclaw] WebSocket connected, authenticating...");
      ws!.send(JSON.stringify({
        type: "auth",
        payload: { apiKey: account.apiKey },
      }));
    });

    const safeSend = (data: string) => {
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      } catch { /* ignore closed socket */ }
    };

    ws.on("message", async (raw: Buffer) => {
      let msg: WSEvent;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try { await handleWSEvent(msg); } catch (err) {
        runtime.error(`[wristclaw] unhandled WS event error: ${String(err)}`);
      }
    });

    const handleWSEvent = async (msg: WSEvent) => {

      // Auth success → subscribe all pairs
      if (msg.type === "authenticated") {
        backoff = 1000; // reset

        // Start keepalive ping every 30s (survives nginx idle timeout)
        // If no pong within 10s, force reconnect
        if (pingInterval) clearInterval(pingInterval);
        if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
        pingInterval = setInterval(() => {
          safeSend(JSON.stringify({ type: "ping" }));
          if (pongTimeout) clearTimeout(pongTimeout);
          pongTimeout = setTimeout(() => {
            runtime.error("[wristclaw] pong timeout (10s), forcing reconnect");
            try { ws?.close(); } catch { /* ignore */ }
          }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);

        runtime.log("[wristclaw] authenticated, fetching conversations...");

        try {
          // Resolve bot's own identity for echo prevention + @mention detection
          if (!botUserId) {
            const identity = await fetchBotIdentity(account);
            botUserId = identity.userId;
            botDisplayName = identity.displayName;
            runtime.log(`[wristclaw] bot user_id: ${botUserId}, name: ${botDisplayName || "(none)"}`);
          }

          // Subscribe to user channel for group:member_added + pair:created
          safeSend(JSON.stringify({ type: "subscribe", channel: `user:${botUserId}` }));

          // Fetch all conversations (pairs + groups) and subscribe
          const conversations = await fetchConversations(account);
          pairToChannel.clear();
          groupChannelIds.clear();
          const subscribedChannels = new Set<string>();
          for (const conv of conversations) {
            if (conv.type === "pair" && conv.pair_id) {
              pairToChannel.set(conv.pair_id, conv.channel_id);
            }
            if (conv.type === "group") {
              groupChannelIds.add(conv.channel_id);
            }
            if (conv.channel_id && !subscribedChannels.has(conv.channel_id)) {
              subscribedChannels.add(conv.channel_id);
              safeSend(JSON.stringify({
                type: "subscribe",
                channel: `channel:${conv.channel_id}`,
              }));
            }
          }
          const pairCount = conversations.filter(c => c.type === "pair").length;
          const groupCount = conversations.filter(c => c.type === "group").length;
          runtime.log(`[wristclaw] monitoring ${pairCount} pairs, ${groupCount} groups`);

          // Catch-up: fetch missed messages during disconnect (skip first connect)
          if (!isFirstConnect) {
            let catchUpTotal = 0;
            for (const conv of conversations) {
              const chId = conv.channel_id;
              if (!chId) continue;
              const lastId = lastSeenMessageId.get(chId);
              if (!lastId) continue;
              try {
                const missed = await fetchMissedMessages(chId, lastId, account);
                for (const m of missed) {
                  if (m.payload?.via === "openclaw") continue;
                  if (botUserId && m.author_id === botUserId) continue;

                  const wsChannel = `channel:${chId}`;
                  const synth = apiMessageToWSEvent(m, wsChannel);
                  const synthChId = extractChannelId(synth, pairToChannel);
                  if (!synthChId) continue;

                  lastSeenMessageId.set(chId, m.message_id);

                  if (activeDispatches >= MAX_CONCURRENT) continue;
                  activeDispatches++;
                  processMessage({ event: synth, channelId: synthChId, wsChannel, ws, botUserId, botDisplayName, isGroupChannel: groupChannelIds.has(synthChId), account, config, core, runtime, statusSink, rateLimitCheck: isRateLimited, dedupCheck: markProcessed, groupHistories, historyLimit, waitForTranscription })
                    .catch((err) => runtime.error(`[wristclaw] catch-up error: ${String(err)}`))
                    .finally(() => { activeDispatches--; });
                  catchUpTotal++;
                }
              } catch (err) {
                runtime.error(`[wristclaw] catch-up failed for ch ${chId}: ${String(err)}`);
              }
            }
            if (catchUpTotal > 0) {
              runtime.log(`[wristclaw] catch-up: dispatched ${catchUpTotal} missed messages`);
            }
          }
          isFirstConnect = false;
        } catch (err) {
          runtime.error(`[wristclaw] pair list failed: ${String(err)}`);
        }
        return;
      }

      // Pong → clear timeout
      if (msg.type === "pong") {
        if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
        return;
      }

      // Subscribed ack
      if (msg.type === "subscribed") {
        return;
      }

      // Inbound message
      if (msg.type === "message:new") {
        const channelId = extractChannelId(msg, pairToChannel);
        if (!channelId) return;

        // Track last seen message for reconnect catch-up
        const msgId = msg.payload?.message_id;
        const authorId = msg.payload?.author_id;
        if (msgId) {
          lastSeenMessageId.set(channelId, msgId);
        }
        if (msgId && authorId) {
          messageAuthorMap.set(msgId, authorId);
          if (messageAuthorMap.size > MESSAGE_AUTHOR_CAP) {
            // Evict oldest entry
            const firstKey = messageAuthorMap.keys().next().value;
            if (firstKey) messageAuthorMap.delete(firstKey);
          }
        }

        statusSink?.({ lastInboundAt: Date.now() });

        // Media group: buffer rapid sequential images from same sender
        const wsChannel = msg.channel ?? "";
        if (bufferOrFlushImage(msg, channelId, wsChannel)) return; // buffered, will dispatch later

        if (activeDispatches >= MAX_CONCURRENT) {
          runtime.log(`[wristclaw] dropping message: ${activeDispatches} dispatches active`);
          return;
        }
        activeDispatches++;
        processMessage({ event: msg, channelId, wsChannel, ws, botUserId, botDisplayName, isGroupChannel: groupChannelIds.has(channelId), account, config, core, runtime, statusSink, rateLimitCheck: isRateLimited, dedupCheck: markProcessed, groupHistories, historyLimit, waitForTranscription })
          .catch((err) => runtime.error(`[wristclaw] process error: ${String(err)}`))
          .finally(() => { activeDispatches--; });
        return;
      }

      // message:update → resolve voice transcription waiters
      if (msg.type === "message:update") {
        const uPayload = msg.payload;
        const msgId = uPayload?.message_id ?? "";
        const uText = uPayload?.text ?? "";
        if (msgId && uText) {
          if (resolveVoiceWaiter(msgId, uText)) {
            runtime.log(`[wristclaw] message:update resolved voice waiter for ${msgId}`);
          }
        }
        return;
      }

      // Bot added to a group → subscribe to its channel
      if (msg.type === "group:member_added" && msg.payload) {
        const chId = msg.payload.channel_id;
        const gName = msg.payload.group_name ?? "group";
        if (chId) {
          groupChannelIds.add(chId);
          safeSend(JSON.stringify({ type: "subscribe", channel: `channel:${chId}` }));
          runtime.log(`[wristclaw] joined group "${gName}" (channel:${chId})`);
        }
        return;
      }

      // Ignore group:member_changed (informational only for plugin)
      if (msg.type === "group:member_changed") return;

      // New pair created → subscribe to its channel
      if (msg.type === "pair:created" && msg.payload) {
        const pairId = msg.payload.pair_id;
        if (pairId) {
          try {
            const pairs = await fetchPairList(account);
            for (const pair of pairs) {
              if (!pairToChannel.has(pair.pair_id)) {
                pairToChannel.set(pair.pair_id, pair.channel_id);
                safeSend(JSON.stringify({
                  type: "subscribe",
                  channel: `channel:${pair.channel_id}`,
                }));
                runtime.log(`[wristclaw] subscribed new pair ${pair.pair_id} (channel:${pair.channel_id})`);
              }
            }
          } catch (err) {
            runtime.error(`[wristclaw] pair refresh failed: ${String(err)}`);
          }
        }
        return;
      }
    };

    ws.on("close", (code, reason) => {
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
      if (stopped || abortSignal.aborted) {
        resolveRunning?.();
        return;
      }
      runtime.log(`[wristclaw] disconnected (${code}), reconnecting in ${backoff}ms`);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });

    ws.on("error", (err) => {
      runtime.error(`[wristclaw] WS error: ${String(err)}`);
      // close event will trigger reconnect
    });
  };

  const stop = () => {
    stopped = true;
    clearInterval(rateLimitCleanup);
    // Flush pending media groups on shutdown
    for (const [key, entry] of mediaGroupBuffer) {
      clearTimeout(entry.timer);
      flushMediaGroup(key);
    }
    // Cancel pending voice waiters
    for (const [id, waiter] of voiceWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("");
    }
    voiceWaiters.clear();
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    resolveRunning?.();
  };

  abortSignal.addEventListener("abort", stop, { once: true });

  // Start connection
  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
  });

  connect();

  await runningPromise;
  return { stop };
}
