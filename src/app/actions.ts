"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/api-keys";
import { AgentError, runAgentTurn } from "@/lib/engine";
import { slugify } from "@/lib/format";
import { DEFAULT_MODEL, isEffort, isModelId, formatSar } from "@/lib/models";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/password";
import { audit, requireOperator, requireOwner, signIn, signOut } from "@/lib/session";
import { AGENT_TEMPLATES, isTemplateId } from "@/lib/templates";

export type FormState = { error?: string; ok?: string; key?: string } | undefined;

const str = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const optional = (form: FormData, name: string) => str(form, name) || null;
function optionalInt(form: FormData, name: string, min: number, max: number) {
  const raw = str(form, name);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`القيمة في الحقل غير صحيحة (من ${min} إلى ${max}).`);
  return value;
}
const message = (error: unknown) => (error instanceof Error ? error.message : "حدث خطأ غير متوقع.");

// ---------- Auth ----------

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    await signIn(str(form, "email"), String(form.get("password") ?? ""));
  } catch (error) {
    return { error: message(error) };
  }
  redirect("/");
}

export async function logoutAction() {
  await signOut();
  redirect("/login");
}

// ---------- Tenants ----------

export async function createTenantAction(_: FormState, form: FormData): Promise<FormState> {
  let id: string;
  try {
    const session = await requireOperator(true);
    const name = str(form, "name");
    if (name.length < 2) return { error: "اكتب اسم المنشأة." };
    let slug = slugify(str(form, "slug") || name);
    if (await db.tenant.findUnique({ where: { slug } })) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await db.tenant.create({
      data: {
        name,
        slug,
        contactName: optional(form, "contactName"),
        contactEmail: optional(form, "contactEmail"),
        monthlyBudgetUsdCents: (() => { const usd = optionalInt(form, "monthlyBudgetUsd", 1, 1_000_000); return usd == null ? null : usd * 100; })(),
      },
    });
    await audit(session, "tenant.create", "tenant", tenant.id, { name });
    id = tenant.id;
  } catch (error) {
    return { error: message(error) };
  }
  redirect(`/tenants/${id}`);
}

export async function updateTenantAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const session = await requireOperator(true);
    const id = str(form, "id");
    const usd = optionalInt(form, "monthlyBudgetUsd", 1, 1_000_000);
    const data = {
      name: str(form, "name"),
      contactName: optional(form, "contactName"),
      contactEmail: optional(form, "contactEmail"),
      notes: optional(form, "notes"),
      monthlyBudgetUsdCents: usd == null ? null : usd * 100,
      rateLimitPerMinute: optionalInt(form, "rateLimitPerMinute", 1, 1000) ?? 30,
    };
    if (data.name.length < 2) return { error: "اكتب اسم المنشأة." };
    await db.tenant.update({ where: { id }, data });
    await audit(session, "tenant.update", "tenant", id, data);
    revalidatePath(`/tenants/${id}`);
    return { ok: "تم الحفظ." };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function setTenantStatusAction(form: FormData) {
  const session = await requireOperator(true);
  const id = str(form, "id");
  const status = str(form, "status") === "suspended" ? "suspended" : "active";
  await db.tenant.update({ where: { id }, data: { status } });
  await audit(session, `tenant.${status === "active" ? "activate" : "suspend"}`, "tenant", id);
  revalidatePath(`/tenants/${id}`);
}

// ---------- Agents ----------

export async function createAgentAction(_: FormState, form: FormData): Promise<FormState> {
  let id: string;
  try {
    const session = await requireOperator(true);
    const tenantId = str(form, "tenantId");
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return { error: "العميل غير موجود." };
    const name = str(form, "name");
    if (name.length < 2) return { error: "اكتب اسم الوكيل." };
    const templateId = str(form, "template");
    const template = AGENT_TEMPLATES[isTemplateId(templateId) ? templateId : "blank"];
    const agent = await db.agent.create({
      data: { tenantId, name, description: template.description || null, systemPrompt: template.prompt.replaceAll("[اسم المنشأة]", tenant.name), model: DEFAULT_MODEL },
    });
    await audit(session, "agent.create", "agent", agent.id, { tenantId, name, template: templateId });
    id = agent.id;
  } catch (error) {
    return { error: message(error) };
  }
  redirect(`/agents/${id}`);
}

const AgentForm = z.object({
  name: z.string().min(2, "اكتب اسم الوكيل.").max(80),
  description: z.string().max(300),
  systemPrompt: z.string().min(10, "اكتب تعليمات الوكيل.").max(20_000, "التعليمات أطول من 20 ألف حرف."),
  knowledge: z.string().max(400_000, "المعرفة أطول من 400 ألف حرف؛ قسّمها أو اختصرها."),
  model: z.string().refine(isModelId, "نموذج غير معروف."),
  effort: z.string().refine(isEffort, "مستوى جهد غير معروف."),
  maxOutputTokens: z.coerce.number().int().min(1024).max(64_000),
  status: z.enum(["draft", "active", "paused"]),
});

export async function updateAgentAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const session = await requireOperator(true);
    const id = str(form, "id");
    const parsed = AgentForm.safeParse({
      name: str(form, "name"),
      description: str(form, "description"),
      systemPrompt: str(form, "systemPrompt"),
      knowledge: str(form, "knowledge"),
      model: str(form, "model"),
      effort: str(form, "effort"),
      maxOutputTokens: str(form, "maxOutputTokens"),
      status: str(form, "status"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "بيانات غير صحيحة." };
    const current = await db.agent.findUnique({ where: { id } });
    if (!current) return { error: "الوكيل غير موجود." };
    const contentChanged = current.systemPrompt !== parsed.data.systemPrompt || current.knowledge !== parsed.data.knowledge;
    await db.agent.update({ where: { id }, data: { ...parsed.data, description: parsed.data.description || null, ...(contentChanged ? { version: { increment: 1 } } : {}) } });
    await audit(session, "agent.update", "agent", id, { model: parsed.data.model, effort: parsed.data.effort, status: parsed.data.status, contentChanged });
    revalidatePath(`/agents/${id}`);
    return { ok: "تم الحفظ." };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function deleteAgentAction(form: FormData) {
  const session = await requireOwner();
  const id = str(form, "id");
  const agent = await db.agent.delete({ where: { id } });
  await audit(session, "agent.delete", "agent", id, { name: agent.name, tenantId: agent.tenantId });
  redirect(`/tenants/${agent.tenantId}`);
}

export type PlaygroundResult = { reply?: string; conversationId?: string; cost?: string; error?: string };

/** Test chat from the dashboard. Uses the real model and is recorded as playground usage. */
export async function playgroundAction(agentId: string, conversationId: string | null, text: string): Promise<PlaygroundResult> {
  try {
    await requireOperator(true);
    const agent = await db.agent.findUnique({ where: { id: agentId }, include: { tenant: true } });
    if (!agent) return { error: "الوكيل غير موجود." };
    const result = await runAgentTurn({ tenant: { ...agent.tenant, status: "active" }, agentId, text, conversationId, source: "playground" });
    return { reply: result.reply || "(رد فارغ)", conversationId: result.conversationId, cost: formatSar(result.usage.costMicroUsd) };
  } catch (error) {
    if (error instanceof AgentError) return { error: `${error.code}: ${error.message}` };
    return { error: message(error) };
  }
}

// ---------- API keys ----------

export async function createKeyAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const session = await requireOperator(true);
    const tenantId = str(form, "tenantId");
    const agentId = optional(form, "agentId");
    if (agentId && !(await db.agent.findFirst({ where: { id: agentId, tenantId } }))) return { error: "الوكيل لا يتبع هذا العميل." };
    const { key, hash, prefix } = generateApiKey();
    const row = await db.apiKey.create({ data: { tenantId, agentId, name: str(form, "name") || "مفتاح", hash, prefix } });
    await audit(session, "api_key.create", "api_key", row.id, { tenantId, agentId, prefix });
    revalidatePath(`/tenants/${tenantId}`);
    return { ok: "أُنشئ المفتاح. انسخه الآن، لن يظهر مرة أخرى.", key };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function revokeKeyAction(form: FormData) {
  const session = await requireOperator(true);
  const id = str(form, "id");
  const key = await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit(session, "api_key.revoke", "api_key", id, { tenantId: key.tenantId, prefix: key.prefix });
  revalidatePath(`/tenants/${key.tenantId}`);
}

// ---------- Team ----------

export async function createOperatorAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const session = await requireOwner();
    const email = str(form, "email").toLowerCase();
    const password = String(form.get("password") ?? "");
    const role = str(form, "role") === "viewer" ? "viewer" : "admin";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "البريد غير صحيح." };
    if (password.length < PASSWORD_MIN_LENGTH) return { error: `كلمة المرور ${PASSWORD_MIN_LENGTH} حرفًا على الأقل.` };
    if (await db.operator.findUnique({ where: { email } })) return { error: "البريد مسجل مسبقًا." };
    const operator = await db.operator.create({ data: { email, name: str(form, "name") || email, role, passwordHash: await hashPassword(password) } });
    await audit(session, "operator.create", "operator", operator.id, { email, role });
    revalidatePath("/team");
    return { ok: "أُضيف الحساب." };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function toggleOperatorAction(form: FormData) {
  const session = await requireOwner();
  const id = str(form, "id");
  if (id === session.operatorId) throw new Error("لا يمكنك إيقاف حسابك.");
  const operator = await db.operator.findUnique({ where: { id } });
  if (!operator || operator.role === "owner") throw new Error("لا يمكن إيقاف هذا الحساب.");
  await db.operator.update({ where: { id }, data: { active: !operator.active, sessionVersion: { increment: 1 } } });
  await audit(session, operator.active ? "operator.disable" : "operator.enable", "operator", id);
  revalidatePath("/team");
}
