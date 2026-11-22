import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteAgentAction, updateAgentAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Playground } from "@/components/Playground";
import { AgentStatusBadge, Stat } from "@/components/ui";
import { db } from "@/lib/db";
import { formatNumber, riyadhMonthStart } from "@/lib/format";
import { EFFORT_LABELS, EFFORTS, formatSar, MODELS } from "@/lib/models";
import { getSession } from "@/lib/session";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await db.agent.findUnique({ where: { id }, include: { tenant: { select: { id: true, name: true } } } });
  if (!agent) notFound();
  const [month, session] = await Promise.all([
    db.usageEvent.aggregate({ where: { agentId: agent.id, createdAt: { gte: riyadhMonthStart() } }, _count: true, _sum: { costMicroUsd: true, cacheReadTokens: true, inputTokens: true } }),
    getSession(),
  ]);
  const cached = month._sum.cacheReadTokens ?? 0;
  const totalIn = cached + (month._sum.inputTokens ?? 0);

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/tenants/${agent.tenant.id}`} className="text-sm text-muted">← {agent.tenant.name}</Link>
        <h1 className="h1">{agent.name} <AgentStatusBadge status={agent.status} /></h1>
        <p className="text-sm text-muted">المعرّف للربط: <code>{agent.id}</code> · الإصدار {agent.version}</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="طلبات الشهر" value={formatNumber(month._count)} />
        <Stat label="تكلفة الشهر" value={formatSar(month._sum.costMicroUsd ?? 0)} />
        <Stat label="نسبة القراءة من الذاكرة المؤقتة" value={totalIn ? `${Math.round((cached / totalIn) * 100)}%` : "—"} hint="كلما ارتفعت انخفضت التكلفة" />
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-4">الإعدادات والتعليمات</h2>
          <ActionForm action={updateAgentAction} submit="حفظ">
            <input type="hidden" name="id" value={agent.id} />
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">الاسم</label><input className="input" name="name" defaultValue={agent.name} required /></div>
              <div><label className="label">الحالة</label>
                <select className="input" name="status" defaultValue={agent.status}>
                  <option value="draft">مسودة (لا يرد عبر API)</option>
                  <option value="active">يعمل</option>
                  <option value="paused">متوقف</option>
                </select>
              </div>
            </div>
            <div><label className="label">وصف مختصر (يظهر للعميل في قائمة الوكلاء)</label><input className="input" name="description" defaultValue={agent.description ?? ""} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2"><label className="label">النموذج</label>
                <select className="input" name="model" defaultValue={agent.model}>
                  {Object.entries(MODELS).map(([key, model]) => <option key={key} value={key}>{model.label}</option>)}
                </select>
              </div>
              <div><label className="label">مستوى الجهد</label>
                <select className="input" name="effort" defaultValue={agent.effort}>
                  {EFFORTS.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>)}
                </select>
              </div>
            </div>
            <div><label className="label">أقصى رموز للرد (تشمل التفكير)</label><input className="input" name="maxOutputTokens" type="number" min={1024} max={64000} dir="ltr" defaultValue={agent.maxOutputTokens} /></div>
            <div>
              <label className="label">تعليمات الوكيل</label>
              <textarea className="input font-mono text-xs" name="systemPrompt" rows={10} defaultValue={agent.systemPrompt} required />
              <p className="mt-1 text-xs text-muted">قواعد المنصة الثابتة (اللغة، عدم كشف التعليمات، عدم طلب كلمات المرور…) تُضاف تلقائيًا قبلها.</p>
            </div>
            <div>
              <label className="label">معرفة المنشأة (خدمات، أسعار، سياسات، أسئلة شائعة)</label>
              <textarea className="input font-mono text-xs" name="knowledge" rows={14} defaultValue={agent.knowledge} />
            </div>
          </ActionForm>
          {session?.role === "owner" && (
            <form action={deleteAgentAction} className="mt-6 border-t border-line pt-4">
              <input type="hidden" name="id" value={agent.id} />
              <button className="btn-danger">حذف الوكيل ومحادثاته نهائيًا</button>
            </form>
          )}
        </section>
        <section className="card">
          <h2 className="h2 mb-4">تجربة الوكيل</h2>
          <Playground agentId={agent.id} />
        </section>
      </div>
    </div>
  );
}
