/**
 * Shared string constants for the WristClaw plugin.
 * Centralizes magic strings to prevent typos and ease refactoring.
 */

/** Plugin / channel identifier */
export const CHANNEL_ID = "wristclaw";

/** Value of `via` field on outbound messages (echo prevention) */
export const VIA_TAG = "openclaw";

/** WS channel prefix for pair/group channels */
export const WS_CHANNEL_PREFIX = "channel:";

/** WS channel prefix for user-level events (pair:created, group:member_added) */
export const WS_USER_PREFIX = "user:";

/** Session key prefix (fixed, not tied to agentId) */
export const SESSION_KEY_PREFIX = "agent:wristclaw";

/** Client request ID prefix for outbound messages */
export const CLIENT_REQUEST_PREFIX = "openclaw";
