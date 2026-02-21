import { WebSocket } from "ws";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount, WristClawPair } from "./types.js";
import { getWristClawRuntime } from "./runtime.js";
import { sendMessageWristClaw } from "./send.js";
import { fetchWithRetry } from "./fetch-utils.js";

type PluginRuntimeType = ReturnType<typeof getWristClawRuntime>;

export type WristClawMonitorOptions = {
  account: ResolvedWristClawAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

// WS event payload from WristClawServer
// Server sends: { type, channel, payload: { author_id, channel_id, message_id, created_at, payload: { content_type, text, media_url, via, ... } } }
type WSEvent = {
  type: string;
  channel?: string;
  payload?: {
    // Top-level fields in WS broadcast payload
    pair_id?: string;
    author_id?: string;
    channel_id?: string;
    message_id?: string;
    created_at?: string;
    media_url?: string;
    // Nested payload (message content)
    payload?: {
      content_type?: string;
      text?: string;
      media_url?: string;
      duration_sec?: number;
      via?: string;
    };
    // Flattened aliases for API long-poll format
    sender_id?: string;
    sender_name?: string;
    content_type?: string;
    text?: string;
    via?: string;
  };
};

const TEXT_LIMIT = 4000;

// ---------------------------------------------------------------------------
// Pair list fetch
// ---------------------------------------------------------------------------

async function fetchBotUserId(account: ResolvedWristClawAccount): Promise<string> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/me`, {
    headers: { Authorization: `Bearer ${account.apiKey}` },
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`/me failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.user_id ?? "";
}

async function fetchPairList(account: ResolvedWristClawAccount): Promise<WristClawPair[]> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/pair/list`, {
    headers: { Authorization: `Bearer ${account.apiKey}` },
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`pair/list failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.pairs ?? [];
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
    headers: { Authorization: `Bearer ${account.apiKey}` },
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? [];
}

function apiMessageToWSEvent(msg: APIMessage, pairChannel: string): WSEvent {
  return {
    type: "message:new",
    channel: pairChannel,
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
  event: WSEvent;
  channelId: string;
  pairChannel: string;
  ws: WebSocket | null;
  botUserId: string;
  account: ResolvedWristClawAccount;
  config: OpenClawConfig;
  core: PluginRuntimeType;
  runtime: RuntimeEnv;
  statusSink?: WristClawMonitorOptions["statusSink"];
  rateLimitCheck?: (senderId: string) => boolean;
  dedupCheck?: (msgId: string) => boolean;
};

async function processMessage(ctx: ProcessMessageCtx): Promise<void> {
  const { event, channelId, pairChannel, ws, botUserId, account, config, core, runtime, statusSink, rateLimitCheck, dedupCheck } = ctx;
  const raw = event.payload;
  if (!raw) return;

  // Normalize: server WS sends nested { payload: { content_type, text, via } }
  // API long-poll sends flat { content_type, text, sender_id, via }
  const nested = raw.payload;
  const via = nested?.via ?? raw.via;
  const contentType = nested?.content_type ?? raw.content_type ?? "text";
  const text = nested?.text ?? raw.text;
  const mediaUrl = nested?.media_url ?? raw.media_url;
  const senderId = raw.author_id ?? raw.sender_id ?? "";
  const senderName = raw.sender_name ?? "";

  // === Echo prevention (double check: via field + sender_id) ===
  if (via === "openclaw") return;
  if (botUserId && senderId === botUserId) return;

  // === Dedup check ===
  const msgId = raw.message_id;
  if (msgId && dedupCheck && !dedupCheck(msgId)) return;

  // === Allowlist check ===
  if (account.config.allowFrom?.length) {
    if (!account.config.allowFrom.some((id) => String(id) === senderId)) return;
  }

  // === Per-sender rate limit (injected via closure) ===
  if (rateLimitCheck && senderId && rateLimitCheck(senderId)) return;

  // Build body from content type
  let rawBody: string;
  if (contentType === "text") {
    rawBody = text?.trim() ?? "";
  } else if (contentType === "voice") {
    // If no transcription yet, skip — will be handled by voice:transcribed event
    const t = text?.trim();
    if (!t) return;
    rawBody = t;
  } else if (contentType === "image") {
    rawBody = text?.trim() || "📷 圖片";
    // mediaUrl will be passed to inbound context below
  } else if (contentType === "interactive") {
    rawBody = text?.trim() || "📋 互動訊息";
  } else {
    rawBody = text?.trim() ?? "";
  }

  if (!rawBody) return;

  // === Parse reply context for AI ===
  const replyTo = (event.payload as Record<string, unknown>)?.reply_to as
    | { message_id?: string; author_id?: string; text_preview?: string }
    | undefined;
  const replyQuoteText = replyTo?.text_preview || "";
  if (replyQuoteText) {
    // Truncate + sanitize: strip control chars, mark as user-quoted content
    const sanitized = replyQuoteText.slice(0, 100).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    rawBody = `[回覆 (user-quoted-content)：「${sanitized}」]\n${rawBody}`;
  }

  // === Resolve agent route ===
  // Both owner and visitors get per-channel isolated sessions (no main session pollution)
  const isOwner = Boolean(account.ownerUserId && senderId === account.ownerUserId);

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
  const route = {
    agentId,
    sessionKey: `agent:${agentId}:wristclaw:${isOwner ? "direct" : "group"}:ch:${channelId}`,
    accountId: account.accountId,
  };

  // === Build inbound context ===
  const storePath = core.channel.session.resolveStorePath(
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

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: envelope,
    BodyForAgent: rawBody,
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
    // Image: pass media URL for vision model
    ...(contentType === "image" && mediaUrl ? { MediaUrl: mediaUrl, MediaType: "image" } : {}),
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
          channel: pairChannel,
          payload: { status },
        }));
      }
    } catch { /* ignore closed socket */ }
  };

  // Start with "thinking" status while AI processes, heartbeat every 3.5s
  sendTypingStatus("thinking");
  let currentTypingStatus: "thinking" | "typing" = "thinking";
  const typingInterval = setInterval(() => sendTypingStatus(currentTypingStatus), 3500);

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
  }
}

// ---------------------------------------------------------------------------
// Extract channel ID from WS event
// ---------------------------------------------------------------------------

function extractChannelId(
  event: WSEvent,
  pairToChannel: Map<string, string>,
): string | null {
  // Server WS broadcast includes channel_id directly
  if (event.payload?.channel_id) {
    return event.payload.channel_id;
  }
  // Try pair_id → channel_id mapping
  const pairId = event.payload?.pair_id;
  if (pairId && pairToChannel.has(pairId)) {
    return pairToChannel.get(pairId)!;
  }
  // Try from WS channel field: "pair:<uuid>"
  if (event.channel?.startsWith("pair:")) {
    const pid = event.channel.slice(5);
    if (pairToChannel.has(pid)) {
      return pairToChannel.get(pid)!;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebSocket monitor with reconnect
// ---------------------------------------------------------------------------

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
  // message_id → author_id cache (for voice:transcribed which lacks author_id)
  // Bounded LRU-ish: evict oldest when exceeding cap
  const MESSAGE_AUTHOR_CAP = 500;
  const messageAuthorMap = new Map<string, string>();
  // Dedup: prevent processing same message twice (WS + catch-up overlap)
  const DEDUP_CAP = 1000;
  const processedMessageIds = new Set<string>();
  // Concurrency limiter: max simultaneous AI dispatches
  const MAX_CONCURRENT = 3;
  let activeDispatches = 0;
  // Per-sender rate limiter: max 10 messages per 60s window
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 10;
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
  }, 300_000);

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
  let isFirstConnect = true;

  const connect = () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    const wsUrl = account.serverUrl.replace(/^http/, "ws") + "/v1/ws";

    // Warn if non-TLS to remote host (API key would be sent in cleartext)
    if (wsUrl.startsWith("ws://") && !/localhost|127\.0\.0\.1|\[::1\]/.test(wsUrl)) {
      runtime.error(`[wristclaw] ⚠️ WARNING: connecting to remote server without TLS — API key transmitted in cleartext! Use https/wss.`);
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
          }, 10_000);
        }, 30_000);

        runtime.log("[wristclaw] authenticated, fetching pairs...");

        try {
          // Resolve bot's own user_id for echo prevention
          if (!botUserId) {
            botUserId = await fetchBotUserId(account);
            runtime.log(`[wristclaw] bot user_id: ${botUserId}`);
          }
          const pairs = await fetchPairList(account);
          pairToChannel.clear();
          for (const pair of pairs) {
            pairToChannel.set(pair.pair_id, pair.channel_id);
            safeSend(JSON.stringify({
              type: "subscribe",
              channel: `pair:${pair.pair_id}`,
            }));
          }
          runtime.log(`[wristclaw] monitoring ${pairs.length} pairs`);

          // Catch-up: fetch missed messages during disconnect (skip first connect)
          if (!isFirstConnect) {
            let catchUpTotal = 0;
            for (const pair of pairs) {
              const chId = pair.channel_id;
              const lastId = lastSeenMessageId.get(chId);
              if (!lastId) continue;
              try {
                const missed = await fetchMissedMessages(chId, lastId, account);
                for (const m of missed) {
                  // Skip own messages (echo prevention)
                  if (m.payload?.via === "openclaw") continue;
                  if (botUserId && m.author_id === botUserId) continue;

                  const pairChannel = `pair:${pair.pair_id}`;
                  const synth = apiMessageToWSEvent(m, pairChannel);
                  const synthChId = extractChannelId(synth, pairToChannel);
                  if (!synthChId) continue;

                  lastSeenMessageId.set(chId, m.message_id);

                  if (activeDispatches >= MAX_CONCURRENT) continue;
                  activeDispatches++;
                  processMessage({ event: synth, channelId: synthChId, pairChannel, ws, botUserId, account, config, core, runtime, statusSink, rateLimitCheck: isRateLimited, dedupCheck: markProcessed })
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

        if (activeDispatches >= MAX_CONCURRENT) {
          runtime.log(`[wristclaw] dropping message: ${activeDispatches} dispatches active`);
          return;
        }
        activeDispatches++;
        processMessage({ event: msg, channelId, pairChannel: msg.channel ?? "", ws, botUserId, account, config, core, runtime, statusSink, rateLimitCheck: isRateLimited, dedupCheck: markProcessed })
          .catch((err) => runtime.error(`[wristclaw] process error: ${String(err)}`))
          .finally(() => { activeDispatches--; });
        return;
      }

      // Voice transcribed → dispatch transcription text to AI
      if (msg.type === "voice:transcribed") {
        const vPayload = msg.payload as Record<string, unknown> | undefined;
        const vText = String(vPayload?.text ?? "").trim();
        if (!vText) return;

        // Resolve channel from pair channel
        const channelId = extractChannelId(msg, pairToChannel);
        if (!channelId) return;

        // author_id: server includes it in voice:transcribed payload; fallback to cache
        const vMsgId = String(vPayload?.message_id ?? "");
        const cachedAuthorId = (vPayload?.author_id as string | undefined)
          ?? (vMsgId ? messageAuthorMap.get(vMsgId) : undefined);

        // Build a synthetic message:new-like event for processMessage
        const syntheticEvent: WSEvent = {
          type: "message:new",
          channel: msg.channel,
          payload: {
            pair_id: vPayload?.pair_id as string | undefined,
            message_id: vMsgId || undefined,
            channel_id: channelId,
            author_id: cachedAuthorId,
            payload: {
              content_type: "voice",
              text: vText,
            },
          },
        };

        statusSink?.({ lastInboundAt: Date.now() });
        if (activeDispatches >= MAX_CONCURRENT) {
          runtime.log(`[wristclaw] dropping voice:transcribed: ${activeDispatches} dispatches active`);
          return;
        }
        activeDispatches++;
        processMessage({ event: syntheticEvent, channelId, pairChannel: msg.channel ?? "", ws, botUserId, account, config, core, runtime, statusSink, rateLimitCheck: isRateLimited, dedupCheck: markProcessed })
          .catch((err) => runtime.error(`[wristclaw] voice:transcribed process error: ${String(err)}`))
          .finally(() => { activeDispatches--; });
        return;
      }

      // New pair created → subscribe
      // TODO: if server includes channel_id in pair:created payload, avoid full re-fetch
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
                  channel: `pair:${pair.pair_id}`,
                }));
                runtime.log(`[wristclaw] subscribed new pair ${pair.pair_id}`);
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
      backoff = Math.min(backoff * 2, 60000);
    });

    ws.on("error", (err) => {
      runtime.error(`[wristclaw] WS error: ${String(err)}`);
      // close event will trigger reconnect
    });
  };

  const stop = () => {
    stopped = true;
    clearInterval(rateLimitCleanup);
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
