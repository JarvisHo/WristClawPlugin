import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount, WristClawChannelConfig } from "./types.js";

const DEFAULT_SERVER_URL = "http://localhost:8090";

export function resolveWristClawAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWristClawAccount {
  const wc = (params.cfg.channels as Record<string, WristClawChannelConfig> | undefined)
    ?.wristclaw ?? {};

  return {
    accountId: params.accountId ?? "default",
    enabled: wc.enabled !== false,
    serverUrl: (wc.serverUrl ?? wc.baseUrl)?.trim() || DEFAULT_SERVER_URL,
    apiKey: wc.apiKey?.trim() ?? "",
    ownerUserId: wc.ownerUserId?.trim() || undefined,
    config: wc,
  };
}

export function listWristClawAccountIds(cfg: OpenClawConfig): string[] {
  const wc = (cfg.channels as Record<string, unknown> | undefined)?.wristclaw;
  return wc ? ["default"] : [];
}
