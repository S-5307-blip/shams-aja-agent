import Anthropic from "@anthropic-ai/sdk";
import type { Agent, Prisma, Tenant, UsageSource } from "@prisma/client";
import { db } from "./db";
import { riyadhMonthStart } from "./format";
import { costMicroUsd, isEffort, type TokenUsage } from "./models";
import { buildSystem, replyText } from "./prompt";

export const MAX_INPUT_CHARS = 8000;
/** A conversation this long is closed; the client starts a new one so each request stays cheap. */
export const MAX_CONVERSATION_MESSAGES = 100;
/** A reply still pending after this long is treated as lost (the server restarted mid-reply). */
export const PENDING_STALE_MS = 5 * 60_000;

export type AgentErrorCode =
  | "invalid_request"
  | "tenant_suspended"
  | "agent_not_found"
  | "agent_inactive"
  | "conversation_not_found"
  | "conversation_full"
  | "conversation_busy"
  | "rate_limited"
  | "budget_exceeded"
  | "refused"
  | "not_configured"
  | "upstream_error";

const STATUS: Record<AgentErrorCode, number> = {
  invalid_request: 400,
  tenant_suspended: 403,
  agent_not_found: 404,
  agent_inactive: 409,
  conversation_not_found: 404,
  conversation_full: 409,
  conversation_busy: 409,
  rate_limited: 429,
  budget_exceeded: 402,
  refused: 422,
  not_configured: 503,
  upstream_error: 502,
};

export class AgentError extends Error {
  readonly status: number;
  constructor(readonly code: AgentErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
/** Calls the model. Injected in tests; in production it streams and returns the final message. */
export type Completer = (params: CreateParams) => Promise<Anthropic.Beta.BetaMessage>;

let client: Anthropic | null = null;

export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const anthropicCompleter: Completer = async (params) => {
  client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 });
  // Streaming keeps long replies clear of HTTP timeouts; we only need the final message.
  return client.beta.messages.stream(params).finalMessage();
};

let activeCompleter: Completer = anthropicCompleter;

/** Swaps the model call (tests only). Pass nothing to restore the real one. */
export function setCompleter(completer?: Completer) {
  activeCompleter = completer ?? anthropicCompleter;
}

export type TurnInput = {
  tenant: Pick<Tenant, "id" | "status" | "rateLimitPerMinute" | "monthlyBudgetUsdCents">;
  agentId: string;
  text: string;
  conversationId?: string | null;
  userRef?: string | null;
  source: UsageSource;
  apiKeyId?: string | null;
};

export type TurnResult = {
  conversationId: string;
  reply: string;
  truncated: boolean;
  model: string;
  usage: TokenUsage & { costMicroUsd: number };
};

export async function monthSpendMicroUsd(tenantId: string, now = new Date()) {
  const sum = await db.usageEvent.aggregate({ where: { tenantId, createdAt: { gte: riyadhMonthStart(now) } }, _sum: { costMicroUsd: true } });
  return sum._sum.costMicroUsd ?? 0;
}

async function checkLimits(tenant: TurnInput["tenant"], source: UsageSource, now: Date) {
  if (source === "api") {
    const recent = await db.usageEvent.count({ where: { tenantId: tenant.id, source: "api", createdAt: { gte: new Date(now.getTime() - 60_000) } } });
    if (recent >= tenant.rateLimitPerMinute) throw new AgentError("rate_limited", "Too many requests. Slow down and retry in a minute.");
  }
  if (tenant.monthlyBudgetUsdCents != null) {
    const spent = await monthSpendMicroUsd(tenant.id, now);
    if (spent >= tenant.monthlyBudgetUsdCents * 10_000) throw new AgentError("budget_exceeded", "This account reached its monthly usage limit. Contact your provider to raise it.");
  }
}

/** Finds or creates the conversation and claims it so only one reply runs at a time. */
async function claimConversation(input: TurnInput, agent: Agent, now: Date) {
  if (!input.conversationId) {
    return db.conversation.create({ data: { tenantId: input.tenant.id, agentId: agent.id, userRef: input.userRef ?? null, source: input.source, pendingSince: now } });
  }
  // Scoped by tenant AND agent: a conversation id from another client or agent is simply "not found".
  const conversation = await db.conversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenant.id, agentId: agent.id } });
  if (!conversation) throw new AgentError("conversation_not_found", "Conversation not found for this agent.");
  if (conversation.messageCount >= MAX_CONVERSATION_MESSAGES) throw new AgentError("conversation_full", "This conversation is full. Start a new one without conversation_id.");
  const claimed = await db.conversation.updateMany({
    where: { id: conversation.id, OR: [{ pendingSince: null }, { pendingSince: { lt: new Date(now.getTime() - PENDING_STALE_MS) } }] },
    data: { pendingSince: now },
  });
  if (!claimed.count) throw new AgentError("conversation_busy", "A reply in this conversation is still in progress.");
  return conversation;
}

function usageFrom(message: Anthropic.Beta.BetaMessage): TokenUsage {
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * One user message in, one agent reply out. Every lookup is scoped to the caller's tenant.
 * Nothing is written to the conversation unless the model answers, so a failed call leaves
 * the history unchanged and the client can simply retry.
 */
export async function runAgentTurn(input: TurnInput, now = new Date()): Promise<TurnResult> {
  const complete = activeCompleter;
  const text = input.text?.trim() ?? "";
  if (!text) throw new AgentError("invalid_request", "message is required.");
  if (text.length > MAX_INPUT_CHARS) throw new AgentError("invalid_request", `message is longer than ${MAX_INPUT_CHARS} characters.`);
  if (input.userRef && input.userRef.length > 200) throw new AgentError("invalid_request", "user_ref is longer than 200 characters.");
  if (input.tenant.status !== "active") throw new AgentError("tenant_suspended", "This account is suspended.");

  const agent = await db.agent.findFirst({ where: { id: input.agentId, tenantId: input.tenant.id } });
  if (!agent) throw new AgentError("agent_not_found", "Agent not found.");
  if (input.source === "api" && agent.status !== "active") throw new AgentError("agent_inactive", "This agent is not active.");
  if (complete === anthropicCompleter && !anthropicConfigured()) throw new AgentError("not_configured", "The platform's model key is not configured yet.");

  await checkLimits(input.tenant, input.source, now);
  const conversation = await claimConversation(input, agent, now);
  const release = () => db.conversation.update({ where: { id: conversation.id }, data: { pendingSince: null } });

  const history = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { seq: "asc" }, select: { role: true, content: true } });
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text }];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((row) => ({ role: row.role, content: row.content as unknown as Anthropic.Beta.BetaContentBlockParam[] })),
    { role: "user", content: userContent },
  ];

  const started = Date.now();
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await complete({
      model: agent.model,
      max_tokens: agent.maxOutputTokens,
      system: buildSystem(agent),
      messages,
      // Caches the conversation so far; the next turn reads it at a tenth of the price.
      cache_control: { type: "ephemeral" },
      output_config: { effort: isEffort(agent.effort) ? agent.effort : "medium" },
      // If the model declines for policy reasons, the API retries on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      metadata: { user_id: input.tenant.id },
    });
  } catch (error) {
    const errorCode = error instanceof Anthropic.APIError ? `anthropic_${error.status ?? "error"}` : "network";
    await db.usageEvent.create({ data: { tenantId: input.tenant.id, agentId: agent.id, apiKeyId: input.apiKeyId ?? null, conversationId: conversation.id, source: input.source, model: agent.model, status: "error", errorCode, latencyMs: Date.now() - started } });
    await release();
    console.error("[agent] model call failed", { agentId: agent.id, errorCode, message: error instanceof Error ? error.message : String(error) });
    throw new AgentError("upstream_error", "The agent could not answer right now. Please retry.");
  }

  const latencyMs = Date.now() - started;
  const usage = usageFrom(message);
  const servedModel = message.model || agent.model;
  const cost = costMicroUsd(servedModel, usage);
  const usageRow = { tenantId: input.tenant.id, agentId: agent.id, apiKeyId: input.apiKeyId ?? null, conversationId: conversation.id, source: input.source, model: servedModel, ...usage, costMicroUsd: cost, latencyMs };

  if (message.stop_reason === "refusal") {
    await db.usageEvent.create({ data: { ...usageRow, status: "refused", errorCode: message.stop_details?.category ?? "refusal" } });
    await release();
    throw new AgentError("refused", "The agent can't help with this request.");
  }

  const reply = replyText(message.content);
  await db.$transaction([
    db.message.create({ data: { conversationId: conversation.id, seq: conversation.messageCount + 1, role: "user", content: userContent as unknown as Prisma.InputJsonValue, text } }),
    db.message.create({ data: { conversationId: conversation.id, seq: conversation.messageCount + 2, role: "assistant", content: message.content as unknown as Prisma.InputJsonValue, text: reply } }),
    db.conversation.update({ where: { id: conversation.id }, data: { messageCount: { increment: 2 }, pendingSince: null } }),
    db.usageEvent.create({ data: { ...usageRow, status: "ok" } }),
    ...(input.apiKeyId ? [db.apiKey.update({ where: { id: input.apiKeyId }, data: { lastUsedAt: now } })] : []),
  ]);

  return { conversationId: conversation.id, reply, truncated: message.stop_reason === "max_tokens", model: servedModel, usage: { ...usage, costMicroUsd: cost } };
}
