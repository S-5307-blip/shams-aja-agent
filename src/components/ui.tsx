import type { AgentStatus, TenantStatus, UsageStatus } from "@prisma/client";

const STYLES = { green: "bg-emerald-100 text-emerald-800", gray: "bg-slate-100 text-slate-700", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-800" };

export function Badge({ tone, children }: { tone: keyof typeof STYLES; children: React.ReactNode }) {
  return <span className={`badge ${STYLES[tone]}`}>{children}</span>;
}

export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  return status === "active" ? <Badge tone="green">نشط</Badge> : <Badge tone="red">موقوف</Badge>;
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  if (status === "active") return <Badge tone="green">يعمل</Badge>;
  if (status === "paused") return <Badge tone="amber">متوقف</Badge>;
  return <Badge tone="gray">مسودة</Badge>;
}

export function UsageStatusBadge({ status }: { status: UsageStatus }) {
  if (status === "ok") return <Badge tone="green">ناجح</Badge>;
  if (status === "refused") return <Badge tone="amber">مرفوض</Badge>;
  return <Badge tone="red">خطأ</Badge>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
