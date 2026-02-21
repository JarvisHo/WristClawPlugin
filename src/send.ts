import { randomUUID } from "node:crypto";
import { fetchWithRetry } from "./fetch-utils.js";

export type InteractiveButton = {
  id: string;
  label: string;
  style?: string;
};

export type InteractivePayload = {
  type: string;
  buttons?: InteractiveButton[];
};

export type SendMessageOptions = {
  serverUrl: string;
  apiKey: string;
  contentType?: string;
  mediaKey?: string;
  durationSec?: number;
  via?: string;
  interactive?: InteractivePayload;
  replyToMessageId?: string;
};

export type SendMessageResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Send a message to a WristClaw channel.
 * POST /v1/channels/{channelId}/messages
 */
/** Validate channelId format to prevent path injection */
function validateChannelId(id: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error(`invalid channelId: ${id.slice(0, 40)}`);
  }
}

export async function sendMessageWristClaw(
  channelId: string,
  text: string,
  opts: SendMessageOptions,
): Promise<SendMessageResult> {
  validateChannelId(channelId);
  const url = `${opts.serverUrl}/v1/channels/${channelId}/messages`;

  const body: Record<string, unknown> = {
    client_request_id: `openclaw-${randomUUID()}`,
    content_type: opts.contentType ?? "text",
    text,
    via: opts.via ?? "openclaw",
  };

  if (opts.mediaKey) {
    body.media_key = opts.mediaKey;
  }
  if (opts.durationSec != null) {
    body.duration_sec = opts.durationSec;
  }
  if (opts.interactive) {
    body.interactive = opts.interactive;
  }
  if (opts.replyToMessageId != null) {
    body.reply_to_message_id = opts.replyToMessageId;
  }

  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
      retries: 2,
    });

    if (res.status === 201) {
      const data = await res.json();
      return { ok: true, messageId: data.message_id };
    }

    const errText = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

/**
 * Parse [[buttons: title | body | btn1:data1, btn2:data2]] template from text.
 * Returns parsed interactive payload + cleaned text, or null if no match.
 */
export function parseInteractiveButtons(
  text: string,
): { text: string; interactive: InteractivePayload } | null {
  const match = text.match(/\[\[buttons:\s*([^\]]+)\]\]/i);
  if (!match) return null;

  const parts = match[1].split("|").map((s) => s.trim());
  if (parts.length < 2) return null;

  // Format: title | body | btn1:data1, btn2:data2
  // Or:     body | btn1:data1, btn2:data2
  let bodyText: string;
  let actionsStr: string;

  if (parts.length >= 3) {
    // title | body | buttons — use body as text (title is for LINE alt text)
    bodyText = parts[1];
    actionsStr = parts.slice(2).join("|"); // rejoin in case buttons contain |
  } else {
    bodyText = parts[0];
    actionsStr = parts[1];
  }

  const buttons: InteractiveButton[] = actionsStr
    .split(",")
    .map((s, i) => {
      const trimmed = s.trim();
      if (!trimmed) return null;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) {
        return { id: trimmed, label: trimmed };
      }
      const label = trimmed.slice(0, colonIdx).trim();
      const id = trimmed.slice(colonIdx + 1).trim() || label;
      return { id, label };
    })
    .filter((b): b is InteractiveButton => b !== null);

  if (buttons.length === 0) return null;

  // Remove template from original text, prepend body
  const cleaned = text.replace(match[0], "").trim();
  const finalText = cleaned ? `${bodyText}\n\n${cleaned}` : bodyText;

  return {
    text: finalText,
    interactive: { type: "buttons", buttons },
  };
}

/**
 * Upload media to WristClaw server.
 * POST /v1/upload (multipart/form-data)
 * Returns media_key on success.
 */
export async function uploadMediaWristClaw(
  fileBuffer: Buffer | Uint8Array,
  filename: string,
  contentType: string,
  mediaType: "image" | "voice",
  opts: { serverUrl: string; apiKey: string },
): Promise<{ ok: boolean; mediaKey?: string; error?: string }> {
  const url = `${opts.serverUrl}/v1/upload`;

  // Sanitize filename to prevent header injection
  const safeFilename = filename.replace(/["\r\n\\]/g, "_");

  // Build multipart form data manually (Node.js)
  const boundary = `----openclaw-${Date.now()}`;
  const parts: Uint8Array[] = [];

  // type field
  parts.push(
    new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mediaType}\r\n`,
    ),
  );

  // file field
  parts.push(
    new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer));
  parts.push(new TextEncoder().encode(`\r\n--${boundary}--\r\n`));

  const bodyLen = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(bodyLen);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }

  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      timeoutMs: 30_000,
      retries: 1,
    });

    if (res.ok) {
      const data = await res.json();
      return { ok: true, mediaKey: data.media_key };
    }
    const errText = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

/**
 * Probe WristClaw server health.
 * GET /health
 */
export async function probeWristClaw(
  serverUrl: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: string; version?: string; error?: string }> {
  try {
    const res = await fetchWithRetry(`${serverUrl}/health`, {
      timeoutMs,
      retries: 1,
    });

    const data = await res.json();
    return {
      ok: data.status === "ok",
      status: data.status,
      version: data.version,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
