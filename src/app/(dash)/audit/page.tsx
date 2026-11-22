import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";

export default async function AuditPage() {
  const rows = await db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { operator: { select: { name: true } } } });
  return (
    <div className="space-y-6">
      <h1 className="h1">سجل التدقيق</h1>
      <p className="text-sm text-muted">كل تعديل على العملاء والوكلاء والمفاتيح والفريق، مع من نفّذه. آخر 200 عملية.</p>
      <section className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>الوقت</th><th>المنفّذ</th><th>العملية</th><th>الهدف</th><th>التفاصيل</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                <td>{row.operator?.name ?? "—"}</td>
                <td><code className="text-xs">{row.action}</code></td>
                <td><code className="text-xs">{row.targetType}:{row.targetId}</code></td>
                <td><code className="block max-w-md truncate text-xs">{row.detail ? JSON.stringify(row.detail) : ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
