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
// Task/Org API helpers
// ---------------------------------------------------------------------------

type TaskInfo = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  task_type?: string;
  assignee_user_id?: string;
  assignee_agent_id?: string;
  channel_id?: string;
  subtask_total?: number;
  subtask_done?: number;
  result?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

async function fetchJson(url: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchWithRetry(url, {
    ...init,
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json", ...init?.headers },
    timeoutMs: 15_000,
    retries: 1,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_list_orgs
// ---------------------------------------------------------------------------

function makeListOrgsTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_list_orgs",
    label: "List Organizations",
    description: "List all organizations the bot belongs to.",
    parameters: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "WristClaw account ID" },
      },
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const data = (await fetchJson(`${account.serverUrl}/v1/orgs`, account.apiKey)) as {
        orgs: Array<{ id: string; name: string; slug: string; is_personal: boolean; role: string }>;
      };
      const orgs = data.orgs ?? [];
      const lines = orgs.map(
        (o) => `- ${o.name} (id: ${o.id}, role: ${o.role}${o.is_personal ? ", personal" : ""})`,
      );
      return { content: [{ type: "text", text: orgs.length > 0 ? lines.join("\n") : "(no orgs)" }], details: { orgs } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_list_tasks
// ---------------------------------------------------------------------------

function makeListTasksTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_list_tasks",
    label: "List Tasks",
    description: "List tasks in a WristClaw organization. Filter by status or assignee.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Organization ID (required)" },
        status: { type: "string", description: "Filter: ready, in_progress, done, pending_review, etc." },
        assignee_id: { type: "string", description: "Filter by assignee user ID" },
        accountId: { type: "string" },
      },
      required: ["orgId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", String(params.status));
      if (params.assignee_id) qs.set("assignee_id", String(params.assignee_id));
      qs.set("limit", "50");
      const data = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks?${qs}`, account.apiKey)) as {
        tasks: TaskInfo[]; total: number;
      };
      const tasks = data.tasks ?? [];
      const lines = tasks.map((t) => `- [${t.status}] ${t.title} (id: ${t.id}, priority: ${t.priority})`);
      return { content: [{ type: "text", text: `${tasks.length} tasks:\n${lines.join("\n") || "(none)"}` }], details: { total: data.total } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_get_task
// ---------------------------------------------------------------------------

function makeGetTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_get_task",
    label: "Get Task",
    description: "Get full details of a task including description, result, and subtask progress.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        taskId: { type: "string" },
        accountId: { type: "string" },
      },
      required: ["orgId", "taskId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/${params.taskId}`, account.apiKey)) as TaskInfo;
      const lines = [
        `# ${task.title}`,
        `Status: ${task.status} | Priority: ${task.priority} | Type: ${task.task_type || "execution"}`,
        task.description ? `\nDescription:\n${task.description}` : "",
        task.result ? `\nResult:\n${JSON.stringify(task.result, null, 2)}` : "",
        task.subtask_total ? `\nSubtasks: ${task.subtask_done || 0}/${task.subtask_total}` : "",
        `Channel: ${task.channel_id || "none"}`,
      ];
      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_create_task
// ---------------------------------------------------------------------------

function makeCreateTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_create_task",
    label: "Create Task",
    description: "Create a new standalone task in an organization.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        priority: { type: "string", description: "low/normal/high/urgent" },
        task_type: { type: "string", description: "exploration/proposal/execution/review" },
        accountId: { type: "string" },
      },
      required: ["orgId", "title"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks`, account.apiKey, {
        method: "POST",
        body: JSON.stringify({ title: params.title, description: params.description || "", priority: params.priority || "normal", task_type: params.task_type || "execution" }),
      })) as TaskInfo;
      return { content: [{ type: "text", text: `Task created: "${task.title}" (id: ${task.id}, channel: ${task.channel_id})` }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_claim_task
// ---------------------------------------------------------------------------

function makeClaimTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_claim_task",
    label: "Claim Task",
    description: "Claim an unassigned ready task and start working on it (atomic assign + start).",
    parameters: {
      type: "object",
      properties: { orgId: { type: "string" }, taskId: { type: "string" }, accountId: { type: "string" } },
      required: ["orgId", "taskId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/${params.taskId}/claim`, account.apiKey, { method: "POST" })) as TaskInfo;
      return { content: [{ type: "text", text: `Claimed: "${task.title}" → ${task.status}` }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_start_task
// ---------------------------------------------------------------------------

function makeStartTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_start_task",
    label: "Start Task",
    description: "Start a ready task that is already assigned to you.",
    parameters: {
      type: "object",
      properties: { orgId: { type: "string" }, taskId: { type: "string" }, accountId: { type: "string" } },
      required: ["orgId", "taskId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/${params.taskId}/start`, account.apiKey, { method: "POST" })) as TaskInfo;
      return { content: [{ type: "text", text: `Started: "${task.title}" → ${task.status}` }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_submit_task
// ---------------------------------------------------------------------------

function makeSubmitTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_submit_task",
    label: "Submit Task",
    description: "Submit a completed task with result output and optional child tasks to spawn.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        taskId: { type: "string" },
        output: { type: "string", description: "Result output text" },
        spawn_tasks: {
          type: "array",
          description: "Child tasks to create",
          items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, task_type: { type: "string" } } },
        },
        accountId: { type: "string" },
      },
      required: ["orgId", "taskId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const body: Record<string, unknown> = {};
      if (params.output) body.result = { output: params.output };
      if (params.spawn_tasks) body.spawn_tasks = params.spawn_tasks;
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/${params.taskId}/submit`, account.apiKey, { method: "POST", body: JSON.stringify(body) })) as TaskInfo;
      return { content: [{ type: "text", text: `Submitted: "${task.title}" → ${task.status}` }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_list_queue
// ---------------------------------------------------------------------------

function makeListQueueTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_list_queue",
    label: "Task Queue",
    description: "List claimable tasks (ready, unassigned, unblocked).",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        task_type: { type: "string", description: "Filter by task type" },
        accountId: { type: "string" },
      },
      required: ["orgId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const qs = new URLSearchParams();
      if (params.task_type) qs.set("task_type", String(params.task_type));
      const data = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/queue?${qs}`, account.apiKey)) as { tasks: TaskInfo[]; total: number };
      const tasks = data.tasks ?? [];
      const lines = tasks.map((t) => `- ${t.title} (id: ${t.id}, priority: ${t.priority}, type: ${t.task_type || "execution"})`);
      return { content: [{ type: "text", text: `${tasks.length} claimable:\n${lines.join("\n") || "(empty)"}` }], details: { total: data.total } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_update_task
// ---------------------------------------------------------------------------

function makeUpdateTaskTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_update_task",
    label: "Update Task",
    description: "Update a task's title, description, priority, or status.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
        status: { type: "string", description: "ready, cancelled, etc." },
        accountId: { type: "string" },
      },
      required: ["orgId", "taskId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const body: Record<string, unknown> = {};
      for (const key of ["title", "description", "priority", "status"]) {
        if (params[key]) body[key] = params[key];
      }
      const task = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/tasks/${params.taskId}`, account.apiKey, { method: "PATCH", body: JSON.stringify(body) })) as TaskInfo;
      return { content: [{ type: "text", text: `Updated: "${task.title}" (status: ${task.status}, priority: ${task.priority})` }], details: task };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_agent_me
// ---------------------------------------------------------------------------

function makeAgentMeTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_agent_me",
    label: "Agent Identity",
    description: "Get this agent's own profile — ID, name, role, capabilities, and status.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Organization ID" },
        accountId: { type: "string" },
      },
      required: ["orgId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const agent = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/agents/me`, account.apiKey)) as {
        id: string; name: string; role: string; capabilities?: string[]; status: string; config?: Record<string, unknown>;
      };
      const caps = agent.capabilities?.length ? agent.capabilities.join(", ") : "none";
      return {
        content: [{ type: "text", text: `Agent: ${agent.name}\nID: ${agent.id}\nRole: ${agent.role}\nCapabilities: ${caps}\nStatus: ${agent.status}` }],
        details: agent,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_send_message
// ---------------------------------------------------------------------------

function makeSendMessageTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_send_message",
    label: "Send Message",
    description: "Send a message to a specific WristClaw channel (task channel, DM, group, etc.).",
    parameters: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel ID to send to" },
        text: { type: "string", description: "Message text" },
        reply_to: { type: "string", description: "Optional message ID to reply to" },
        accountId: { type: "string" },
      },
      required: ["channelId", "text"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const body: Record<string, unknown> = {
        client_request_id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content_type: "text",
        text: params.text,
        via: "openclaw",
      };
      if (params.reply_to) body.reply_to_message_id = params.reply_to;
      const msg = (await fetchJson(`${account.serverUrl}/v1/channels/${params.channelId}/messages`, account.apiKey, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { message_id: string; channel_id: string };
      return {
        content: [{ type: "text", text: `Message sent (id: ${msg.message_id})` }],
        details: msg,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_list_cases
// ---------------------------------------------------------------------------

function makeListCasesTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_list_cases",
    label: "List Inbox Cases",
    description: "List customer service inbox cases. Filter by status (open, pending, resolved, closed).",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Organization ID" },
        status: { type: "string", description: "Filter: open, pending, resolved, closed" },
        accountId: { type: "string" },
      },
      required: ["orgId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", String(params.status));
      qs.set("limit", "50");
      const data = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/inbox?${qs}`, account.apiKey)) as {
        cases: Array<{ id: string; customer_id: string; status: string; priority: string; source: string; channel_id?: string; created_at: string }>;
        total: number;
      };
      const cases = data.cases ?? [];
      const lines = cases.map((c) => `- [${c.status}] ${c.source} customer:${c.customer_id.slice(0, 8)} (id: ${c.id}, channel: ${c.channel_id || "none"})`);
      return { content: [{ type: "text", text: `${cases.length} cases:\n${lines.join("\n") || "(none)"}` }], details: { total: data.total } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: wristclaw_update_case
// ---------------------------------------------------------------------------

function makeUpdateCaseTool(cfg: OpenClawConfig): AgentTool {
  return {
    name: "wristclaw_update_case",
    label: "Update Inbox Case",
    description: "Update an inbox case's status or priority.",
    parameters: {
      type: "object",
      properties: {
        orgId: { type: "string" },
        caseId: { type: "string", description: "Inbox case ID" },
        status: { type: "string", description: "open, pending, resolved, closed" },
        priority: { type: "string", description: "low, normal, high, urgent" },
        accountId: { type: "string" },
      },
      required: ["orgId", "caseId"],
    },
    execute: async (_callId, params) => {
      const account = resolveWristClawAccount({ cfg, accountId: params.accountId as string | undefined });
      const body: Record<string, unknown> = {};
      if (params.status) body.status = params.status;
      if (params.priority) body.priority = params.priority;
      const updated = (await fetchJson(`${account.serverUrl}/v1/orgs/${params.orgId}/inbox/${params.caseId}`, account.apiKey, {
        method: "PATCH",
        body: JSON.stringify(body),
      })) as { id: string; status: string; priority: string };
      return { content: [{ type: "text", text: `Case updated: ${updated.id} → status: ${updated.status}` }], details: updated };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createAgentTools(cfg: OpenClawConfig): AgentTool[] {
  return [
    makeContactsTool(cfg),
    makeAgentMeTool(cfg),
    makeSendMessageTool(cfg),
    makeListOrgsTool(cfg),
    makeListTasksTool(cfg),
    makeGetTaskTool(cfg),
    makeCreateTaskTool(cfg),
    makeClaimTaskTool(cfg),
    makeStartTaskTool(cfg),
    makeSubmitTaskTool(cfg),
    makeListQueueTool(cfg),
    makeUpdateTaskTool(cfg),
    makeListCasesTool(cfg),
    makeUpdateCaseTool(cfg),
  ];
}
