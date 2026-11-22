import Link from "next/link";
import { createTenantAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { TenantStatusBadge } from "@/components/ui";
import { db } from "@/lib/db";
import { riyadhMonthStart } from "@/lib/format";
import { formatSar } from "@/lib/models";

export default async function TenantsPage() {
  const [tenants, spend] = await Promise.all([
    db.tenant.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { agents: true, apiKeys: { where: { revokedAt: null } } } } } }),
    db.usageEvent.groupBy({ by: ["tenantId"], where: { createdAt: { gte: riyadhMonthStart() } }, _sum: { costMicroUsd: true } }),
  ]);
  const spent = new Map(spend.map((row) => [row.tenantId, row._sum.costMicroUsd ?? 0]));

  return (
    <div className="space-y-8">
      <h1 className="h1">العملاء (المنشآت)</h1>
      <section className="card">
        {tenants.length === 0 ? <p className="text-sm text-muted">لا عملاء بعد. أضف أول عميل من النموذج بالأسفل.</p> : (
          <table className="table">
            <thead><tr><th>العميل</th><th>الحالة</th><th>الوكلاء</th><th>المفاتيح الفعالة</th><th>تكلفة الشهر</th></tr></thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td><Link className="font-medium text-brand underline" href={`/tenants/${tenant.id}`}>{tenant.name}</Link><span className="block text-xs text-muted" dir="ltr">{tenant.slug}</span></td>
                  <td><TenantStatusBadge status={tenant.status} /></td>
                  <td>{tenant._count.agents}</td>
                  <td>{tenant._count.apiKeys}</td>
                  <td>{formatSar(spent.get(tenant.id) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card max-w-xl">
        <h2 className="h2 mb-4">إضافة عميل</h2>
        <ActionForm action={createTenantAction} submit="إضافة">
          <div><label className="label">اسم المنشأة</label><input className="input" name="name" required /></div>
          <div><label className="label">معرّف لاتيني (اختياري)</label><input className="input" name="slug" dir="ltr" placeholder="acme-trading" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">اسم المسؤول</label><input className="input" name="contactName" /></div>
            <div><label className="label">بريد المسؤول</label><input className="input" name="contactEmail" type="email" dir="ltr" /></div>
          </div>
          <div><label className="label">سقف التكلفة الشهري بالدولار (اختياري)</label><input className="input" name="monthlyBudgetUsd" type="number" min={1} dir="ltr" placeholder="50" /></div>
        </ActionForm>
      </section>
    </div>
  );
}
