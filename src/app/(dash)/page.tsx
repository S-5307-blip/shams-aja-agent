import Link from "next/link";
import { db } from "@/lib/db";
import { anthropicConfigured } from "@/lib/engine";
import { formatDateTime, formatNumber, riyadhMonthStart } from "@/lib/format";
import { formatSar, formatUsd } from "@/lib/models";
import { Stat, UsageStatusBadge } from "@/components/ui";

export default async function OverviewPage() {
  const since = riyadhMonthStart();
  const [tenants, agents, month, byTenant, recentErrors] = await Promise.all([
    db.tenant.count({ where: { status: "active" } }),
    db.agent.count({ where: { status: "active" } }),
    db.usageEvent.aggregate({ where: { createdAt: { gte: since } }, _sum: { costMicroUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true }, _count: true }),
    db.usageEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _sum: { costMicroUsd: true }, _count: true, orderBy: { _sum: { costMicroUsd: "desc" } }, take: 10 }),
    db.usageEvent.findMany({ where: { status: { not: "ok" } }, orderBy: { createdAt: "desc" }, take: 8, include: { tenant: { select: { name: true } }, agent: { select: { name: true } } } }),
  ]);
  const names = new Map((await db.tenant.findMany({ where: { id: { in: byTenant.map((row) => row.tenantId) } }, select: { id: true, name: true, monthlyBudgetUsdCents: true } })).map((t) => [t.id, t]));
  const cost = month._sum.costMicroUsd ?? 0;

  return (
    <div className="space-y-8">
      <h1 className="h1">نظرة عامة — هذا الشهر</h1>
      {!anthropicConfigured() && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">مفتاح <code>ANTHROPIC_API_KEY</code> غير مضاف في إعدادات الخادم، فلن يرد أي وكيل حتى يُضاف.</div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="عملاء نشطون" value={tenants} />
        <Stat label="وكلاء يعملون" value={agents} />
        <Stat label="طلبات هذا الشهر" value={formatNumber(month._count)} hint={`${formatNumber((month._sum.inputTokens ?? 0) + (month._sum.cacheReadTokens ?? 0))} رمز إدخال · ${formatNumber(month._sum.outputTokens ?? 0)} رمز إخراج`} />
        <Stat label="تكلفة النموذج التقديرية" value={formatSar(cost)} hint={formatUsd(cost)} />
      </div>

      <section className="card">
        <h2 className="h2 mb-3">أعلى العملاء استهلاكًا</h2>
        {byTenant.length === 0 ? <p className="text-sm text-muted">لا استهلاك هذا الشهر بعد.</p> : (
          <table className="table">
            <thead><tr><th>العميل</th><th>الطلبات</th><th>التكلفة</th><th>السقف الشهري</th></tr></thead>
            <tbody>
              {byTenant.map((row) => {
                const tenant = names.get(row.tenantId);
                return (
                  <tr key={row.tenantId}>
                    <td><Link className="text-brand underline" href={`/tenants/${row.tenantId}`}>{tenant?.name ?? row.tenantId}</Link></td>
                    <td>{formatNumber(row._count)}</td>
                    <td>{formatSar(row._sum.costMicroUsd ?? 0)}</td>
                    <td>{tenant?.monthlyBudgetUsdCents != null ? `$${tenant.monthlyBudgetUsdCents / 100}` : "بلا سقف"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="h2 mb-3">آخر الأخطاء والرفض</h2>
        {recentErrors.length === 0 ? <p className="text-sm text-muted">لا أخطاء.</p> : (
          <table className="table">
            <thead><tr><th>الوقت</th><th>العميل</th><th>الوكيل</th><th>الحالة</th><th>الرمز</th></tr></thead>
            <tbody>
              {recentErrors.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>{row.tenant.name}</td>
                  <td><Link className="text-brand underline" href={`/agents/${row.agentId}`}>{row.agent.name}</Link></td>
                  <td><UsageStatusBadge status={row.status} /></td>
                  <td><code className="text-xs">{row.errorCode}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
