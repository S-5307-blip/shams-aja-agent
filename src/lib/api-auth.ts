import { NextResponse } from "next/server";
import { db } from "./db";
import { hashApiKey, readApiKey } from "./api-keys";
import { AgentError } from "./engine";

export type ApiCaller = Awaited<ReturnType<typeof authenticate>>;

/** Resolves the caller's tenant from its API key. Revoked keys and suspended tenants are refused. */
export async function authenticate(headers: Headers) {
  const key = readApiKey(headers);
  if (!key) return null;
  const apiKey = await db.apiKey.findUnique({
    where: { hash: hashApiKey(key) },
    include: { tenant: { select: { id: true, name: true, status: true, rateLimitPerMinute: true, monthlyBudgetUsdCents: true } } },
  });
  if (!apiKey || apiKey.revokedAt) return null;
  return apiKey;
}

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export const unauthorized = () => apiError(401, "unauthorized", "Missing or invalid API key.");

export function fromAgentError(error: unknown) {
  if (error instanceof AgentError) return apiError(error.status, error.code, error.message);
  console.error("[api] unexpected error", error);
  return apiError(500, "internal_error", "Unexpected error.");
}
