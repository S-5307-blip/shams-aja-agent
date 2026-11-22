import { NextResponse } from "next/server";
import { authenticate, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The active agents this key may call. */
export async function GET(request: Request) {
  const caller = await authenticate(request.headers);
  if (!caller) return unauthorized();
  const agents = await db.agent.findMany({
    where: { tenantId: caller.tenantId, status: "active", ...(caller.agentId ? { id: caller.agentId } : {}) },
    select: { id: true, name: true, description: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ data: agents }, { headers: { "Cache-Control": "no-store" } });
}
