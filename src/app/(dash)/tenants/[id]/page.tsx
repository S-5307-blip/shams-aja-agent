import Link from "next/link";
import { notFound } from "next/navigation";
import { createAgentAction, createKeyAction, revokeKeyAction, setTenantStatusAction, updateTenantAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { AgentStatusBadge, Stat, TenantStatusBadge } from "@/components/ui";
import { db } from "@/lib/db";
import { monthSpendMicroUsd } from "@/lib/engine";
import { formatDateTime, formatNumber, riyadhMonthStart } from "@/lib/format";
import { formatSar, formatUsd, MODELS, isModelId } from "@/lib/models";
import { AGENT_TEMPLATES } from "@/lib/templates";

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await db.tenant.findUnique({
    where: { id },
    include: {
      agents: { orderBy: { createdAt: "asc" } },
      apiKeys: { orderBy: { createdAt: "desc" }, include: { agent: { select: { name: true } } } },
      conversations: { where: { source: "api" }, orderBy: { updatedAt: "desc" }, take: 15, include: { agent: { select: { name: true } } } },
    },
  });
  if (!tenant) notFound();
  const since = riyadhMonthStart();
  const [spent, month] = await Promise.all([
    monthSpendMicroUsd(tenant.id),
    db.usageEvent.aggregate({ where: { tenantId: tenant.id, createdAt: { gte: since } }, _count: true, _avg: { latencyMs: true } }),
  ]);
  const budgetMicro = tenant.monthlyBudgetUsdCents != null ? tenant.monthlyBudgetUsdCents * 10_000 : null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/tenants" className="text-sm text-muted">← العملاء</Link>
          <h1 className="h1">{tenant.name} <TenantStatusBadge status={tenant.status} /></h1>
        </div>
        <form action={setTenantStatusAction}>
          <input type="hidden" name="id" value={tenant.id} />
          <input type="hidden" name="status" value={tenant.status === "active" ? "suspended" : "active"} />
          <button className={tenant.status === "active" ? "btn-danger" : "btn-ghost"}>{tenant.status === "active" ? "إيقاف العميل (يوقف كل مفاتيحه)" : "إعادة تفعيل العميل"}</button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="تكلفة الشهر" value={formatSar(spent)} hint={formatUsd(spent)} />
        <Stat label="من السقف" value={budgetMicro ? `${Math.min(100, Math.round((spent / budgetMicro) * 100))}%` : "بلا سقف"} hint={budgetMicro ? `السقف $${tenant.monthlyBudgetUsdCents! / 100}` : undefined} />
        <Stat label="طلبات الشهر" value={formatNumber(month._count)} />
        <Stat label="متوسط زمن الرد" value={month._avg.latencyMs ? `${(month._avg.latencyMs / 1000).toFixed(1)} ث` : "—"} />
      </div>

      <section className="card">
        <h2 className="h2 mb-3">الوكلاء</h2>
        {tenant.agents.length > 0 && (
          <table className="table mb-6">
            <thead><tr><th>الوكيل</th><th>الحالة</th><th>النموذج</th><th>الإصدار</th><th>المعرّف</th></tr></thead>
            <tbody>
              {tenant.agents.map((agent) => (
                <tr key={agent.id}>
                  <td><Link className="font-medium text-brand underline" href={`/agents/${agent.id}`}>{agent.name}</Link></td>
                  <td><AgentStatusBadge status={agent.status} /></td>
                  <td className="text-xs">{isModelId(agent.model) ? MODELS[agent.model].label : agent.model}</td>
                  <td>{agent.version}</td>
                  <td><code className="text-xs">{agent.id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ActionForm action={createAgentAction} submit="إنشاء وكيل" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tenantId" value={tenant.id} />
          <div className="min-w-48 flex-1"><label className="label">اسم الوكيل</label><input className="input" name="name" required /></div>
          <div className="min-w-48"><label className="label">القالب</label>
            <select className="input" name="template" defaultValue="support">
              {Object.entries(AGENT_TEMPLATES).map(([key, template]) => <option key={key} value={key}>{template.label}</option>)}
            </select>
          </div>
        </ActionForm>
      </section>

      <section className="card">
        <h2 className="h2 mb-1">مفاتيح الربط (API)</h2>
        <p className="mb-3 text-sm text-muted">يُعطى المفتاح لفريق العميل التقني ليربط أنظمته بالوكيل. يُعرض مرة واحدة فقط عند إنشائه، ويُحفظ لدينا مشفّرًا ببصمة لا تُعكس.</p>
        {tenant.apiKeys.length > 0 && (
          <table className="table mb-6">
            <thead><tr><th>الاسم</th><th>البداية</th><th>مقيّد بوكيل</th><th>آخر استخدام</th><th>الحالة</th><th></th></tr></thead>
            <tbody>
              {tenant.apiKeys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td><code className="text-xs">{key.prefix}…</code></td>
                  <td>{key.agent?.name ?? "كل وكلاء العميل"}</td>
                  <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "—"}</td>
                  <td>{key.revokedAt ? <span className="text-red-700">ملغى</span> : <span className="text-emerald-700">فعّال</span>}</td>
                  <td>{!key.revokedAt && (
                    <form action={revokeKeyAction}><input type="hidden" name="id" value={key.id} /><button className="btn-danger">إلغاء</button></form>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ActionForm action={createKeyAction} submit="إنشاء مفتاح" className="space-y-3">
          <input type="hidden" name="tenantId" value={tenant.id} />
          <div className="flex flex-wrap gap-3">
            <div className="min-w-48 flex-1"><label className="label">اسم المفتاح</label><input className="input" name="name" placeholder="نظام الإنتاج" /></div>
            <div className="min-w-48"><label className="label">تقييد بوكيل</label>
              <select className="input" name="agentId" defaultValue="">
                <option value="">كل وكلاء العميل</option>
                {tenant.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
          </div>
        </ActionForm>
      </section>

      <section className="card">
        <h2 className="h2 mb-3">آخر المحادثات</h2>
        {tenant.conversations.length === 0 ? <p className="text-sm text-muted">لا محادثات عبر الواجهة البرمجية بعد.</p> : (
          <table className="table">
            <thead><tr><th>آخر نشاط</th><th>الوكيل</th><th>مرجع المستخدم</th><th>الرسائل</th></tr></thead>
            <tbody>
              {tenant.conversations.map((c) => (
                <tr key={c.id}>
                  <td><Link className="text-brand underline" href={`/conversations/${c.id}`}>{formatDateTime(c.updatedAt)}</Link></td>
                  <td>{c.agent.name}</td>
                  <td>{c.userRef ?? "—"}</td>
                  <td>{c.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card max-w-2xl">
        <h2 className="h2 mb-4">بيانات العميل والحدود</h2>
        <ActionForm action={updateTenantAction} submit="حفظ">
          <input type="hidden" name="id" value={tenant.id} />
          <div><label className="label">اسم المنشأة</label><input className="input" name="name" defaultValue={tenant.name} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">اسم المسؤول</label><input className="input" name="contactName" defaultValue={tenant.contactName ?? ""} /></div>
            <div><label className="label">بريد المسؤول</label><input className="input" name="contactEmail" type="email" dir="ltr" defaultValue={tenant.contactEmail ?? ""} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">سقف التكلفة الشهري ($، فارغ = بلا سقف)</label><input className="input" name="monthlyBudgetUsd" type="number" min={1} dir="ltr" defaultValue={tenant.monthlyBudgetUsdCents != null ? tenant.monthlyBudgetUsdCents / 100 : ""} /></div>
            <div><label className="label">حد الطلبات في الدقيقة</label><input className="input" name="rateLimitPerMinute" type="number" min={1} max={1000} dir="ltr" defaultValue={tenant.rateLimitPerMinute} /></div>
          </div>
          <div><label className="label">ملاحظات داخلية (العقد، الباقة…)</label><textarea className="input" name="notes" rows={3} defaultValue={tenant.notes ?? ""} /></div>
        </ActionForm>
      </section>
    </div>
  );
}
