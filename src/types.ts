// ---------------------------------------------------------------------------
// Type placement rules:
// - Shared across files → types.ts
// - File-private (WS events, channelData shapes, etc.) → keep in source file
// ---------------------------------------------------------------------------

/** Base result type for all WristClaw API operations */
export type BaseResult = {
  ok: boolean;
  error?: string;
};

/** WristClaw channel config shape (channels.wristclaw in openclaw.json) */
export type WristClawChannelConfig = {
  enabled?: boolean;
  serverUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  ownerUserId?: string;
  secretaryAgentId?: string;

  // --- DM policy ---
  /** DM access policy: "open" (anyone), "allowlist" (only allowFrom), "disabled" (reject all DMs).
   *  Default: "open" */
  dmPolicy?: "open" | "allowlist" | "disabled";
  /** Allowlist for DMs — user IDs or "*" for wildcard. Only enforced when dmPolicy="allowlist". */
  allowFrom?: Array<string | number>;

  // --- Group policy ---
  /** Group access policy: "mention" (@mention required), "open" (respond to all), "disabled".
   *  Default: "mention" */
  groupPolicy?: "mention" | "open" | "disabled";
  /** Optional allowlist for groups — only these user IDs can trigger the bot (even with @mention).
   *  Empty = anyone in the group can trigger. Supports "*". */
  groupAllowFrom?: Array<string | number>;
  /** Names the bot responds to when @mentioned in groups (default: bot display_name) */
  mentionNames?: string[];
  /** Max recent group messages to include as context when @mentioned (default: 20) */
  historyLimit?: number;
};

/** Resolved account after reading config */
export type ResolvedWristClawAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  serverUrl: string;
  apiKey: string;
  ownerUserId?: string;
  config: WristClawChannelConfig;
};

/** Conversation from GET /v1/conversations */
export type WristClawConversation = {
  type: "pair" | "group";
  channel_id: string;
  pair_id?: string;
  group_name?: string;
};

/** WristClaw pair from GET /v1/pair/list */
export type WristClawPair = {
  pair_id: string;
  channel_id: string;
  user: {
    id: string;
    display_name?: string;
    email?: string;
    avatar_url?: string;
  };
  created_at: string;
  nickname?: string;
  last_message?: {
    message_id: string;
    content_type: string;
    preview: string;
    sender_id: string;
    created_at: string;
  };
};
