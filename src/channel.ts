import type { ChannelPlugin, ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { loadWebMedia } from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount } from "./types.js";
import { resolveWristClawAccount, listWristClawAccountIds } from "./config.js";
import { sendMessageWristClaw, uploadMediaWristClaw, probeWristClaw, parseInteractiveButtons, type InteractivePayload } from "./send.js";
import { getWristClawRuntime, getRuntimeEnv } from "./runtime.js";
import { monitorWristClawProvider } from "./monitor.js";
import { CHANNEL_ID } from "./constants.js";

/** channelData.wristclaw shape from OpenClaw core */
type WristClawChannelData = {
  interactive?: InteractivePayload;
  replyToMessageId?: string;
};

/** channelData.telegram shape (inline buttons) */
type TelegramChannelData = {
  buttons?: { text: string; callback_data?: string }[][];
};

/** channelData.line shape (parsed from [[buttons:...]] template by OpenClaw core) */
type LineChannelData = {
  templateMessage?: {
    type: string;
    title?: string;
    text?: string;
    actions?: { label: string; data?: string; type?: string }[];
  };
};

export const wristclawPlugin: ChannelPlugin<ResolvedWristClawAccount> = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "WristClaw",
    selectionLabel: "WristClaw (API)",
    docsPath: "/channels/wristclaw",
    blurb: "WristClaw messaging via WebSocket + REST API.",
    aliases: ["wc", "speaka"],
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
    inlineButtons: "all",
  },

  reload: { configPrefixes: ["channels.wristclaw"] },

  config: {
    listAccountIds: (cfg) => listWristClawAccountIds(cfg),

    resolveAccount: (cfg, accountId) => resolveWristClawAccount({ cfg, accountId }),

    isConfigured: (account) => Boolean(account.apiKey?.trim()),

    isEnabled: (account) => account.enabled,

    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.apiKey?.trim()),
      baseUrl: account.serverUrl,
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,

    chunker: (text, limit) =>
      getWristClawRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",

    sendText: async ({ to, text, cfg, replyToId, accountId }) => {
      const account = resolveWristClawAccount({ cfg, accountId });
      if (!account.apiKey) {
        return { ok: false, error: "WristClaw API key not configured" };
      }

      const replyToMessageId = replyToId ?? undefined;

      // Parse [[buttons: title | text | btn1:data1, btn2:data2]] template
      const parsed = parseInteractiveButtons(text);
      if (parsed) {
        const result = await sendMessageWristClaw(to, parsed.text, {
          serverUrl: account.serverUrl,
          apiKey: account.apiKey,
          contentType: "interactive",
          interactive: parsed.interactive,
          replyToMessageId,
        });
        return { channel: CHANNEL_ID, ...result };
      }

      const result = await sendMessageWristClaw(to, text, {
        serverUrl: account.serverUrl,
        apiKey: account.apiKey,
        replyToMessageId,
      });

      return { channel: CHANNEL_ID, ...result };
    },

    sendPayload: async ({ to, text: rawText, payload, cfg, accountId }) => {
      let text = rawText;
      const account = resolveWristClawAccount({ cfg, accountId });
      if (!account.apiKey) {
        return { ok: false, error: "WristClaw API key not configured" };
      }

      // Extract interactive payload from channelData (SDK types are opaque — cast required)
      const wcData = payload?.channelData?.wristclaw as WristClawChannelData | undefined;
      const tgData = payload?.channelData?.telegram as TelegramChannelData | undefined;
      const lineData = payload?.channelData?.line as LineChannelData | undefined;

      let interactive: InteractivePayload | undefined = wcData?.interactive;

      if (!interactive && lineData?.templateMessage?.type === "buttons") {
        const actions = lineData.templateMessage.actions || [];
        const buttons = actions.map((a, i) => ({
          id: a.data || a.label || `btn_${i}`,
          label: a.label,
        }));
        if (buttons.length > 0) {
          interactive = { type: "buttons", buttons };
          // Use LINE template text if main text is empty
          if (!text && lineData.templateMessage.text) {
            text = lineData.templateMessage.text;
          }
        }
      }

      if (!interactive && tgData?.buttons) {
        // Convert Telegram inline keyboard to WristClaw buttons
        const buttons = tgData.buttons
          .flat()
          .map((btn, i) => ({
            id: btn.callback_data || `btn_${i}`,
            label: btn.text,
          }));
        if (buttons.length > 0) {
          interactive = { type: "buttons", buttons };
        }
      }

      const replyToMessageId = wcData?.replyToMessageId;

      if (interactive) {
        const result = await sendMessageWristClaw(to, text || "", {
          serverUrl: account.serverUrl,
          apiKey: account.apiKey,
          contentType: "interactive",
          interactive,
          replyToMessageId,
        });
        return { channel: CHANNEL_ID, ...result };
      }

      // Fallback to text
      const result = await sendMessageWristClaw(to, text || "", {
        serverUrl: account.serverUrl,
        apiKey: account.apiKey,
        replyToMessageId,
      });
      return { channel: CHANNEL_ID, ...result };
    },

    sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, cfg, accountId }) => {
      const account = resolveWristClawAccount({ cfg, accountId });
      if (!account.apiKey) {
        return { ok: false, error: "WristClaw API key not configured" };
      }

      if (mediaUrl) {
        try {
          // Use framework's loadWebMedia — supports file://, HTTP, localRoots
          const media = await loadWebMedia(mediaUrl, {
            localRoots: mediaLocalRoots,
          });

          const ct = media.contentType || "image/png";
          const ext = ct.includes("jpeg") || ct.includes("jpg") ? ".jpg" : ct.includes("gif") ? ".gif" : ".png";
          const fileName = media.fileName || `image${ext}`;

          const upload = await uploadMediaWristClaw(media.buffer, fileName, ct, "image", {
            serverUrl: account.serverUrl,
            apiKey: account.apiKey,
          });

          if (upload.ok && upload.mediaKey) {
            const result = await sendMessageWristClaw(to, text || "", {
              serverUrl: account.serverUrl,
              apiKey: account.apiKey,
              contentType: "image",
              mediaKey: upload.mediaKey,
            });
            return { channel: CHANNEL_ID, ...result };
          }
          // Upload failed — log and fall through to text fallback
          getRuntimeEnv().error(`[wristclaw] sendMedia upload failed: ${upload.error}`);
        } catch (err) {
          getRuntimeEnv().error(`[wristclaw] sendMedia error: ${err}`);
        }
      }

      // Fallback: send as text with link (image upload failed)
      const fallbackText = text
        ? `${text}\n\n⚠️ 圖片傳送失敗\n📎 ${mediaUrl ?? "(media)"}`
        : `⚠️ 圖片傳送失敗\n📎 ${mediaUrl ?? "(media)"}`;

      const result = await sendMessageWristClaw(to, fallbackText, {
        serverUrl: account.serverUrl,
        apiKey: account.apiKey,
      });

      return { channel: CHANNEL_ID, ...result };
    },
  },

  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    probeAccount: async ({ account, timeoutMs }) => {
      return probeWristClaw(account.serverUrl, timeoutMs);
    },

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.apiKey?.trim()),
      baseUrl: account.serverUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[wristclaw] starting provider (account: ${account.accountId})`);
      return monitorWristClawProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ ...ctx.getStatus(), ...patch }),
      });
    },
  },

  messaging: {
    normalizeTarget: (raw) => raw.trim(),
    targetResolver: {
      looksLikeId: (raw) => /^\d+$/.test(raw.trim()),
      hint: "<channelId>",
    },
  },
};
