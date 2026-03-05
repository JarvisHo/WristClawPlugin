import type { ResolvedWristClawAccount } from "./types.js";
import { resolveWristClawAccount, listWristClawAccountIds } from "./config.js";
import { authHeaders } from "./send.js";
import { fetchWithRetry } from "./fetch-utils.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Minimal AgentTool type (no typebox dependency)
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };
type AgentToolResult<T> = { content: TextContent[]; details: T };
type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  label: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>;
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type PairInfo = {
  pair_id: string;
  channel_id: string;
  user: { id: string; display_name?: string };
};

async function fetchPairList(account: ResolvedWristClawAccount): Promise<PairInfo[]> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/pair/list`, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) throw new Error(`pair/list failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.pairs ?? [];
}

type GroupInfo = {
  channel_id: string;
  name: string;
  member_count?: number;
};

async function fetchGroups(account: ResolvedWristClawAccount): Promise<GroupInfo[]> {
  const res = await fetchWithRetry(`${account.serverUrl}/v1/groups`, {
    headers: authHeaders(account.apiKey),
    timeoutMs: 10_000,
    retries: 2,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.groups ?? [];
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_contacts
// ---------------------------------------------------------------------------

function makeContactsTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_contacts",
    label: "WristClaw Contacts",
    description:
      "List all WristClaw conversations (pairs and groups) with their channel IDs. Use channel IDs as `target` when sending messages via the `message` tool.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "WristClaw account ID (e.g. alpha, beta). Omit for all accounts.",
        },
      },
    },
    execute: async (_callId, params) => {
      const accountIds = params.accountId
        ? [String(params.accountId)]
        : listWristClawAccountIds(cfg);

      const results: string[] = [];

      for (const acctId of accountIds) {
        const account = resolveWristClawAccount({ cfg, accountId: acctId });
        if (!account.apiKey) {
          results.push(`[${acctId}] not configured`);
          continue;
        }

        try {
          const [pairs, groups] = await Promise.all([
            fetchPairList(account),
            fetchGroups(account),
          ]);

          results.push(`## Account: ${acctId}`);

          if (pairs.length > 0) {
            results.push("### Pairs (DM)");
            for (const p of pairs) {
              const name = p.user.display_name || p.user.id;
              results.push(`- ${name} → channel: ${p.channel_id}`);
            }
          }

          if (groups.length > 0) {
            results.push("### Groups");
            for (const g of groups) {
              const members = g.member_count ? ` (${g.member_count} members)` : "";
              results.push(`- ${g.name}${members} → channel: ${g.channel_id}`);
            }
          }

          if (pairs.length === 0 && groups.length === 0) {
            results.push("(no conversations)");
          }
        } catch (err) {
          results.push(`[${acctId}] error: ${String(err)}`);
        }
      }

      const text = results.join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createAgentTools(cfg: OpenClawConfig): AgentTool[] {
  return [makeContactsTool(cfg)];
}
