/** WristClaw channel config shape (channels.wristclaw in openclaw.json) */
export type WristClawChannelConfig = {
  enabled?: boolean;
  serverUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  ownerUserId?: string;
  secretaryAgentId?: string;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
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

/** WristClaw send message response */
export type WristClawSendResult = {
  message_id: string;
  channel_id: string;
  author_id: string;
  payload: {
    text?: string;
    content_type?: string;
    via?: string;
  };
  created_at: string;
};
