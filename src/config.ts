import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount, WristClawChannelConfig } from "./types.js";

const DEFAULT_SERVER_URL = "http://localhost:8090";

/** Resolve WristClaw account config from OpenClaw config, applying defaults. */
export function resolveWristClawAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWristClawAccount {
  const wc = (params.cfg.channels as Record<string, WristClawChannelConfig> | undefined)
    ?.wristclaw ?? {};

  const id = params.accountId ?? "default";

  // Multi-account mode: merge top-level defaults ← account overrides
  const acct = wc.accounts?.[id];
  if (acct) {
    // Merge: account fields override top-level channel fields
    const merged = { ...wc, ...acct };
    return {
      accountId: id,
      enabled: acct.enabled ?? wc.enabled !== false,
      serverUrl: (acct.serverUrl ?? acct.baseUrl ?? wc.serverUrl ?? wc.baseUrl)?.trim() || DEFAULT_SERVER_URL,
      apiKey: acct.apiKey?.trim() ?? "",
      ownerUserId: (acct.ownerUserId ?? wc.ownerUserId)?.trim() || undefined,
      config: merged,
    };
  }

  // Legacy single-account mode (apiKey at top level)
  return {
    accountId: id,
    enabled: wc.enabled !== false,
    serverUrl: (wc.serverUrl ?? wc.baseUrl)?.trim() || DEFAULT_SERVER_URL,
    apiKey: wc.apiKey?.trim() ?? "",
    ownerUserId: wc.ownerUserId?.trim() || undefined,
    config: wc,
  };
}

/** List configured WristClaw account IDs. */
export function listWristClawAccountIds(cfg: OpenClawConfig): string[] {
  const wc = (cfg.channels as Record<string, WristClawChannelConfig> | undefined)?.wristclaw;
  if (!wc) return [];

  // Multi-account mode
  if (wc.accounts && Object.keys(wc.accounts).length > 0) {
    return Object.keys(wc.accounts);
  }

  // Legacy single-account mode
  if (wc.apiKey) return ["default"];
  return [];
}
