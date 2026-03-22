/**
 * TaskProcessor — handles automatic task processing when tasks are
 * assigned to or created for this agent.
 *
 * Flow: task:created WS event → fetch task → dispatch to AI agent
 *       → agent uses tools (claim, start, send_message, submit)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ResolvedWristClawAccount } from "./types.js";
import { getWristClawRuntime } from "./runtime.js";
import { getRuntimeEnv } from "./runtime.js";
import { sendMessageWristClaw, authHeaders } from "./send.js";
import { fetchWithRetry } from "./fetch-utils.js";
import { CHANNEL_ID } from "./constants.js";
import { BoundedSet } from "./bounded-map.js";
import type WebSocket from "ws";

type TaskEvent = {
  task_id: string;
  org_id: string;
  title?: string;
  status?: string;
  priority?: string;
  channel_id?: string;
  assignee_agent_id?: string;
  claimed_by_agent?: string;
};

type TaskDetails = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  task_type?: string;
  channel_id?: string;
  subtask_total?: number;
  subtask_done?: number;
};

// Prevent processing the same task twice (e.g. rapid WS events)
const processedTasks = new BoundedSet<string>(200);

// Max concurrent task processing
const MAX_CONCURRENT = 3;
let activeCount = 0;

export type TaskProcessorDeps = {
  account: ResolvedWristClawAccount;
  config: OpenClawConfig;
  botUserId: string;
  ws: WebSocket | null;
};

/**
 * Called when a task:created or task:claimed event arrives.
 * If the task is assigned to this agent, fetches details and dispatches to AI.
 */
export async function handleTaskEvent(
  event: TaskEvent,
  deps: TaskProcessorDeps,
): Promise<void> {
  const log = getRuntimeEnv();
  const { account, config, botUserId } = deps;

  // Only process if assigned to this agent
  const isAssignedToMe =
    event.assignee_agent_id === botUserId ||
    event.claimed_by_agent === botUserId;
  if (!isAssignedToMe) return;

  // Dedup
  if (!event.task_id || processedTasks.has(event.task_id)) return;
  processedTasks.add(event.task_id);

  // Concurrency guard
  if (activeCount >= MAX_CONCURRENT) {
    log.log(`[task-processor] skipping task ${event.task_id} (${activeCount} active, max ${MAX_CONCURRENT})`);
    return;
  }

  activeCount++;
  try {
    await processTask(event, deps);
  } catch (err) {
    log.error(`[task-processor] error processing task ${event.task_id}: ${String(err)}`);
  } finally {
    activeCount--;
  }
}

async function processTask(
  event: TaskEvent,
  deps: TaskProcessorDeps,
): Promise<void> {
  const log = getRuntimeEnv();
  const { account, config } = deps;
  const core = getWristClawRuntime();

  // Fetch full task details
  const taskRes = await fetchWithRetry(
    `${account.serverUrl}/v1/orgs/${event.org_id}/tasks/${event.task_id}`,
    { headers: authHeaders(account.apiKey), timeoutMs: 10_000, retries: 1 },
  );
  if (!taskRes.ok) {
    log.error(`[task-processor] failed to fetch task ${event.task_id}: HTTP ${taskRes.status}`);
    return;
  }
  const task = (await taskRes.json()) as TaskDetails;

  // Build instruction for the AI
  const subtaskInfo = task.subtask_total
    ? `\nSubtasks: ${task.subtask_done || 0}/${task.subtask_total} completed`
    : "";
  const instruction = [
    `You have been assigned a new task in organization ${event.org_id}.`,
    ``,
    `**Task: ${task.title}**`,
    `Status: ${task.status} | Priority: ${task.priority} | Type: ${task.task_type || "execution"}`,
    task.description ? `\nDescription:\n${task.description}` : "",
    subtaskInfo,
    task.channel_id ? `\nTask channel: ${task.channel_id}` : "",
    `Task ID: ${task.id}`,
    `Org ID: ${event.org_id}`,
    ``,
    `Please process this task:`,
    `1. If status is "ready", use wristclaw_start_task to begin`,
    `2. Read the description and subtasks carefully`,
    `3. Send progress updates to the task channel using wristclaw_send_message`,
    `4. When done, use wristclaw_submit_task with your result output`,
  ].filter(Boolean).join("\n");

  log.log(`[task-processor] processing task "${task.title}" (${task.id})`);

  // Send a message to the task channel indicating we're starting
  if (task.channel_id) {
    try {
      await sendMessageWristClaw(
        task.channel_id,
        `🤖 Agent 已收到任務「${task.title}」，開始處理中...`,
        { serverUrl: account.serverUrl, apiKey: account.apiKey },
      );
    } catch {
      // best-effort
    }
  }

  // Dispatch to AI agent
  const route = core.channel.route.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    senderId: "system",
    isOwner: true,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: instruction,
    BodyForAgent: instruction,
    RawBody: instruction,
    CommandBody: instruction,
    CommandAuthorized: true,
    From: `wristclaw:system`,
    To: `wristclaw:task:${task.id}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `Task: ${task.title}`,
    SenderName: "Task System",
    SenderId: "system",
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: `task-${task.id}-${Date.now()}`,
    OriginatingChannel: CHANNEL_ID as const,
    OriginatingTo: `wristclaw:task:${task.id}`,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        const text = core.channel.text.convertMarkdownTables(
          (replyPayload as { text?: string }).text ?? "",
          "code",
        );
        if (!text || !task.channel_id) return;

        // Send AI response to the task channel
        await sendMessageWristClaw(
          task.channel_id,
          text,
          { serverUrl: account.serverUrl, apiKey: account.apiKey },
        );
      },
      onModelSelected,
    },
  });

  log.log(`[task-processor] completed task "${task.title}" (${task.id})`);
}
