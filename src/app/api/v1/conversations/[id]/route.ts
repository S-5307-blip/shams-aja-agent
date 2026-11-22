import { NextResponse } from "next/server";
import { apiError, authenticate, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** A conversation's messages. Only conversations of the key's tenant (and agent, if bound) are visible. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await authenticate(request.headers);
  if (!caller) return unauthorized();
  const { id } = await params;
  const conversation = await db.conversation.findFirst({
    where: { id, tenantId: caller.tenantId, source: "api", ...(caller.agentId ? { agentId: caller.agentId } : {}) },
    select: { id: true, agentId: true, userRef: true, createdAt: true, messages: { orderBy: { seq: "asc" }, select: { role: true, text: true, createdAt: true } } },
  });
  if (!conversation) return apiError(404, "conversation_not_found", "Conversation not found.");
  return NextResponse.json(
    {
      id: conversation.id,
      agent_id: conversation.agentId,
      user_ref: conversation.userRef,
      created_at: conversation.createdAt,
      messages: conversation.messages.map((m) => ({ role: m.role, text: m.text, created_at: m.createdAt })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
