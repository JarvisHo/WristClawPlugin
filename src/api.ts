import { readFileSync } from "node:fs";
import type { WristClawChannelConfig, WristClawUpdate, WristClawProbe, WristClawPair } from "./types.js";

export function resolveApiKey(config: WristClawChannelConfig): string {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyFile) {
    return readFileSync(config.apiKeyFile, "utf8").trim();
  }
  throw new Error("WristClaw: no apiKey or apiKeyFile configured");
}

function authHeaders(config: WristClawChannelConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${resolveApiKey(config)}`,
  };
}

function jsonHeaders(config: WristClawChannelConfig): Record<string, string> {
  return {
    ...authHeaders(config),
    "Content-Type": "application/json",
  };
}

export async function getMe(config: WristClawChannelConfig): Promise<WristClawProbe> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/api/me`, { headers: authHeaders(config) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { ok: boolean; data: WristClawProbe["user"] };
    return { ok: true, user: body.data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function listPairs(config: WristClawChannelConfig): Promise<WristClawPair[]> {
  const res = await fetch(`${config.baseUrl}/v1/api/pairs`, { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`listPairs: HTTP ${res.status}`);
  const body = await res.json() as { ok: boolean; data: { pairs: WristClawPair[] } };
  return body.data?.pairs ?? [];
}

export async function sendMessage(
  config: WristClawChannelConfig,
  pairId: string,
  text: string,
): Promise<{ messageId: string }> {
  const res = await fetch(`${config.baseUrl}/v1/api/pairs/${pairId}/messages`, {
    method: "POST",
    headers: jsonHeaders(config),
    body: JSON.stringify({ type: "text", text }),
  });
  if (!res.ok) throw new Error(`sendMessage: HTTP ${res.status}`);
  const body = await res.json() as { ok: boolean; message_id: string };
  return { messageId: body.message_id };
}

export async function getUpdates(
  config: WristClawChannelConfig,
  offset: number,
  signal?: AbortSignal,
): Promise<WristClawUpdate[]> {
  const timeout = config.pollTimeoutSec ?? 30;
  const url = `${config.baseUrl}/v1/api/updates?offset=${offset}&limit=100&timeout=${timeout}`;
  const res = await fetch(url, {
    headers: authHeaders(config),
    signal,
  });
  if (!res.ok) throw new Error(`getUpdates: HTTP ${res.status}`);
  const body = await res.json() as { ok: boolean; updates: WristClawUpdate[] };
  return body.updates ?? [];
}
