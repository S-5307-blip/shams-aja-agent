import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import type { OperatorRole } from "@prisma/client";
import { db } from "./db";
import { verifyPassword } from "./password";

export const SESSION_COOKIE = "agents_session";
const SESSION_SECONDS = 12 * 3600;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export type OperatorSession = { operatorId: string; name: string; email: string; role: OperatorRole };

function authKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set to 32 characters or more.");
  return new TextEncoder().encode(secret);
}

/** Secure cookies in production, except when APP_URL is plain http (a local production build). */
function secureCookies() {
  return process.env.NODE_ENV === "production" && !process.env.APP_URL?.startsWith("http://");
}

const INVALID_LOGIN = "البريد أو كلمة المرور غير صحيحة.";

export async function signIn(email: string, password: string, now = new Date()) {
  const operator = await db.operator.findUnique({ where: { email: email.trim().toLowerCase() }, omit: { passwordHash: false } });
  if (operator?.lockedUntil && operator.lockedUntil > now) {
    throw new Error(`الحساب مقفل مؤقتًا بعد محاولات خاطئة. حاول بعد ${LOCK_MINUTES} دقيقة.`);
  }
  const ok = await verifyPassword(password, operator?.passwordHash ?? null);
  if (!operator || !ok || !operator.active) {
    if (operator) {
      const failed = operator.failedLogins + 1;
      await db.operator.update({
        where: { id: operator.id },
        data: failed >= MAX_FAILED_LOGINS ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) } : { failedLogins: failed },
      });
    }
    throw new Error(INVALID_LOGIN);
  }
  await db.operator.update({ where: { id: operator.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  const token = await new SignJWT({ sub: operator.id, v: operator.sessionVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(authKey());
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies(), sameSite: "strict", path: "/", maxAge: SESSION_SECONDS });
  await db.auditLog.create({ data: { operatorId: operator.id, action: "operator.login", targetType: "operator", targetId: operator.id } });
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function getSession(): Promise<OperatorSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, authKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    const operator = await db.operator.findUnique({ where: { id: payload.sub } });
    if (!operator?.active || operator.sessionVersion !== payload.v) return null;
    return { operatorId: operator.id, name: operator.name, email: operator.email, role: operator.role };
  } catch {
    return null;
  }
}

/** For pages and server actions: the signed-in operator, or a redirect to the login page. */
export async function requireOperator(write = false): Promise<OperatorSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (write && session.role === "viewer") throw new Error("حسابك للاطلاع فقط.");
  return session;
}

export async function requireOwner() {
  const session = await requireOperator(true);
  if (session.role !== "owner") throw new Error("هذا الإجراء للمالك فقط.");
  return session;
}

export async function audit(session: OperatorSession, action: string, targetType: string, targetId?: string | null, detail?: Record<string, unknown>) {
  await db.auditLog.create({ data: { operatorId: session.operatorId, action, targetType, targetId: targetId ?? null, detail: detail ? JSON.parse(JSON.stringify(detail)) : undefined } });
}
