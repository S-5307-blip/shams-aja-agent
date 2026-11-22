import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "@/lib/api-keys";
import { db } from "@/lib/db";
import { AgentError, MAX_CONVERSATION_MESSAGES, runAgentTurn, setCompleter } from "@/lib/engine";
import { POST as chat } from "@/app/api/v1/chat/route";
import { GET as listAgents } from "@/app/api/v1/agents/route";
import { GET as getConversation } from "@/app/api/v1/conversations/[id]/route";

const RUN = Boolean(process.env.TEST_DATABASE_URL);
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

function fakeMessage(text: string, extra: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as Anthropic.Beta.BetaMessage;
}

async function seed() {
  const a = await db.tenant.create({ data: { name: "Tenant A", slug: `a-${Date.now()}-${Math.random()}` } });
  const b = await db.tenant.create({ data: { name: "Tenant B", slug: `b-${Date.now()}-${Math.random()}` } });
  const agentA = await db.agent.create({ data: { tenantId: a.id, name: "Agent A", systemPrompt: "You help A.", knowledge: "A secret price: 42", status: "active" } });
  const agentA2 = await db.agent.create({ data: { tenantId: a.id, name: "Agent A2", systemPrompt: "You help A2.", status: "active" } });
  const agentB = await db.agent.create({ data: { tenantId: b.id, name: "Agent B", systemPrompt: "You help B.", status: "active" } });
  const keyA = generateApiKey();
  const keyB = generateApiKey();
  const keyA2Only = generateApiKey();
  await db.apiKey.create({ data: { tenantId: a.id, name: "a", hash: keyA.hash, prefix: keyA.prefix } });
  await db.apiKey.create({ data: { tenantId: b.id, name: "b", hash: keyB.hash, prefix: keyB.prefix } });
  await db.apiKey.create({ data: { tenantId: a.id, agentId: agentA2.id, name: "a2", hash: keyA2Only.hash, prefix: keyA2Only.prefix } });
  return { a, b, agentA, agentA2, agentB, keyA: keyA.key, keyB: keyB.key, keyA2Only: keyA2Only.key };
}

const post = (key: string, body: unknown) =>
  chat(new Request("http://test/api/v1/chat", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

describe.skipIf(!RUN)("agent engine and API (PostgreSQL)", () => {
  let calls: Params[] = [];

  beforeEach(async () => {
    calls = [];
    setCompleter(async (params) => {
      calls.push(params);
      return fakeMessage(`reply ${calls.length}`);
    });
    await db.usageEvent.deleteMany();
    await db.tenant.deleteMany();
  });

  afterAll(async () => {
    setCompleter();
    await db.$disconnect();
  });

  it("answers, stores the turn, records usage and continues the conversation with full history", async () => {
    const s = await seed();
    const first = await post(s.keyA, { agent_id: s.agentA.id, message: "hello", user_ref: "u1" });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.reply).toBe("reply 1");
    expect(calls[0].system).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("A secret price: 42") })]));
    expect(calls[0].output_config?.effort).toBe("medium");
    expect(calls[0].fallbacks).toBe("default");

    const second = await post(s.keyA, { agent_id: s.agentA.id, message: "again", conversation_id: body.conversation_id });
    expect(second.status).toBe(200);
    expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    const usage = await db.usageEvent.findMany({ where: { tenantId: s.a.id } });
    expect(usage).toHaveLength(2);
    // 100 input * 4 + 900 cache reads * 0.4 + 20 output * 20
    expect(usage[0].costMicroUsd).toBe(400 + 360 + 400);
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: body.conversation_id } });
    expect(conversation.messageCount).toBe(4);
    expect(conversation.pendingSince).toBeNull();
  });

  it("isolates tenants: another tenant's agents and conversations are invisible", async () => {
    const s = await seed();
    const own = await (await post(s.keyA, { agent_id: s.agentA.id, message: "hi" })).json();

    // Tenant B cannot call tenant A's agent, nor read or continue its conversation.
    expect((await post(s.keyB, { agent_id: s.agentA.id, message: "hi" })).status).toBe(404);
    expect((await post(s.keyB, { agent_id: s.agentB.id, message: "hi", conversation_id: own.conversation_id })).status).toBe(404);
    const read = await getConversation(new Request("http://test", { headers: { authorization: `Bearer ${s.keyB}` } }), { params: Promise.resolve({ id: own.conversation_id }) });
    expect(read.status).toBe(404);
    const list = await (await listAgents(new Request("http://test", { headers: { authorization: `Bearer ${s.keyB}` } }))).json();
    expect(list.data.map((agent: { id: string }) => agent.id)).toEqual([s.agentB.id]);
    // A conversation also can't be moved to a different agent of the same tenant.
    expect((await post(s.keyA, { agent_id: s.agentA2.id, message: "hi", conversation_id: own.conversation_id })).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("enforces agent-bound keys, revoked keys and suspended tenants", async () => {
    const s = await seed();
    expect((await post(s.keyA2Only, { message: "hi" })).status).toBe(200);
    expect((await post(s.keyA2Only, { agent_id: s.agentA.id, message: "hi" })).status).toBe(403);
    expect((await post(s.keyA, { message: "hi" })).status).toBe(400);

    await db.apiKey.updateMany({ where: { tenantId: s.b.id }, data: { revokedAt: new Date() } });
    expect((await post(s.keyB, { agent_id: s.agentB.id, message: "hi" })).status).toBe(401);
    expect((await post("sak_live_wrong", { agent_id: s.agentB.id, message: "hi" })).status).toBe(401);

    await db.tenant.update({ where: { id: s.a.id }, data: { status: "suspended" } });
    const suspended = await post(s.keyA, { agent_id: s.agentA.id, message: "hi" });
    expect(suspended.status).toBe(403);
    expect((await suspended.json()).error.code).toBe("tenant_suspended");
  });

  it("refuses draft agents over the API but allows the dashboard playground", async () => {
    const s = await seed();
    await db.agent.update({ where: { id: s.agentA.id }, data: { status: "draft" } });
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "hi" })).status).toBe(409);
    const result = await runAgentTurn({ tenant: s.a, agentId: s.agentA.id, text: "test", source: "playground" });
    expect(result.reply).toBe("reply 1");
  });

  it("applies the per-minute rate limit and the monthly budget", async () => {
    const s = await seed();
    await db.tenant.update({ where: { id: s.a.id }, data: { rateLimitPerMinute: 2 } });
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "1" })).status).toBe(200);
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "2" })).status).toBe(200);
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "3" })).status).toBe(429);

    // Budget of 1 cent = 10,000 micro-USD; two turns above already cost 2,320.
    await db.tenant.update({ where: { id: s.a.id }, data: { rateLimitPerMinute: 100, monthlyBudgetUsdCents: 1 } });
    await db.usageEvent.create({ data: { tenantId: s.a.id, agentId: s.agentA.id, source: "api", model: "claude-opus-5-5", status: "ok", costMicroUsd: 8000, createdAt: new Date(Date.now() - 120_000) } });
    const over = await post(s.keyA, { agent_id: s.agentA.id, message: "4" });
    expect(over.status).toBe(402);
    expect((await over.json()).error.code).toBe("budget_exceeded");
  });

  it("does not store anything when the model fails or refuses, and releases the conversation", async () => {
    const s = await seed();
    const ok = await (await post(s.keyA, { agent_id: s.agentA.id, message: "hi" })).json();

    setCompleter(async () => { throw new Error("boom"); });
    const failed = await post(s.keyA, { agent_id: s.agentA.id, message: "again", conversation_id: ok.conversation_id });
    expect(failed.status).toBe(502);

    setCompleter(async () => fakeMessage("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } } as never));
    const refused = await post(s.keyA, { agent_id: s.agentA.id, message: "bad", conversation_id: ok.conversation_id });
    expect(refused.status).toBe(422);

    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: ok.conversation_id } });
    expect(conversation.messageCount).toBe(2);
    expect(conversation.pendingSince).toBeNull();
    const statuses = (await db.usageEvent.findMany({ where: { tenantId: s.a.id }, orderBy: { createdAt: "asc" } })).map((u) => [u.status, u.errorCode]);
    expect(statuses).toEqual([["ok", null], ["error", "network"], ["refused", "cyber"]]);
  });

  it("rejects a second reply while one is pending, and closes full conversations", async () => {
    const s = await seed();
    const ok = await (await post(s.keyA, { agent_id: s.agentA.id, message: "hi" })).json();
    await db.conversation.update({ where: { id: ok.conversation_id }, data: { pendingSince: new Date() } });
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "x", conversation_id: ok.conversation_id })).status).toBe(409);

    await db.conversation.update({ where: { id: ok.conversation_id }, data: { pendingSince: null, messageCount: MAX_CONVERSATION_MESSAGES } });
    const full = await post(s.keyA, { agent_id: s.agentA.id, message: "x", conversation_id: ok.conversation_id });
    expect((await full.json()).error.code).toBe("conversation_full");
  });

  it("validates input", async () => {
    const s = await seed();
    expect((await post(s.keyA, { agent_id: s.agentA.id, message: "x".repeat(8001) })).status).toBe(400);
    expect((await post(s.keyA, { agent_id: s.agentA.id })).status).toBe(400);
    await expect(runAgentTurn({ tenant: s.a, agentId: s.agentA.id, text: "   ", source: "api" })).rejects.toBeInstanceOf(AgentError);
  });
});
