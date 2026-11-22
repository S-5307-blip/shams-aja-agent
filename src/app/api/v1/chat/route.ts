import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, authenticate, fromAgentError, unauthorized } from "@/lib/api-auth";
import { runAgentTurn } from "@/lib/engine";

export const dynamic = "force-dynamic";
// A reply with deep thinking can take a while; keep the route alive for it.
export const maxDuration = 300;

const Body = z.object({
  agent_id: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(8000),
  conversation_id: z.string().min(1).max(64).nullish(),
  user_ref: z.string().min(1).max(200).nullish(),
});

export async function POST(request: Request) {
  const caller = await authenticate(request.headers);
  if (!caller) return unauthorized();

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return apiError(400, "invalid_request", "Body must be JSON: { agent_id, message, conversation_id?, user_ref? }.");
  }
  // A key bound to one agent can only call that agent; an unbound key must name the agent.
  const agentId = caller.agentId ?? body.agent_id;
  if (!agentId) return apiError(400, "invalid_request", "agent_id is required for this key.");
  if (caller.agentId && body.agent_id && body.agent_id !== caller.agentId) return apiError(403, "forbidden", "This key is limited to another agent.");

  try {
    const result = await runAgentTurn({ tenant: caller.tenant, agentId, text: body.message, conversationId: body.conversation_id, userRef: body.user_ref, source: "api", apiKeyId: caller.id });
    return NextResponse.json(
      {
        conversation_id: result.conversationId,
        reply: result.reply,
        truncated: result.truncated,
        usage: { input_tokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens, output_tokens: result.usage.outputTokens },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fromAgentError(error);
  }
}
