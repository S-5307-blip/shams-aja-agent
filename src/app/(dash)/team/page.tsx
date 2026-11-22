import { createOperatorAction, toggleOperatorAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireOperator } from "@/lib/session";

const ROLE = { owner: "مالك", admin: "مدير", viewer: "اطلاع فقط" } as const;

export default async function TeamPage() {
  const session = await requireOperator();
  const operators = await db.operator.findMany({ orderBy: { createdAt: "asc" } });
  return (
    <div className="space-y-8">
      <h1 className="h1">فريق المنصة</h1>
      <p className="text-sm text-muted">حسابات لوحة التحكم هذه منفصلة تمامًا عن حسابات موقع المكتب.</p>
      <section className="card">
        <table className="table">
          <thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>آخر دخول</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {operators.map((op) => (
              <tr key={op.id}>
                <td>{op.name}</td>
                <td dir="ltr" className="text-left">{op.email}</td>
                <td>{ROLE[op.role]}</td>
                <td>{op.lastLoginAt ? formatDateTime(op.lastLoginAt) : "—"}</td>
                <td>{op.active ? "فعّال" : "موقوف"}</td>
                <td>{session.role === "owner" && op.role !== "owner" && (
                  <form action={toggleOperatorAction}><input type="hidden" name="id" value={op.id} /><button className={op.active ? "btn-danger" : "btn-ghost"}>{op.active ? "إيقاف" : "تفعيل"}</button></form>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {session.role === "owner" && (
        <section className="card max-w-xl">
          <h2 className="h2 mb-4">إضافة عضو</h2>
          <ActionForm action={createOperatorAction} submit="إضافة">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">الاسم</label><input className="input" name="name" required /></div>
              <div><label className="label">الدور</label>
                <select className="input" name="role" defaultValue="admin"><option value="admin">مدير</option><option value="viewer">اطلاع فقط</option></select>
              </div>
            </div>
            <div><label className="label">البريد</label><input className="input" name="email" type="email" dir="ltr" required /></div>
            <div><label className="label">كلمة مرور مؤقتة (12 حرفًا فأكثر)</label><input className="input" name="password" type="password" dir="ltr" minLength={12} required autoComplete="new-password" /></div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
