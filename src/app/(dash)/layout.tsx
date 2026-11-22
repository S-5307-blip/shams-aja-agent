import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/", label: "نظرة عامة" },
  { href: "/tenants", label: "العملاء والوكلاء" },
  { href: "/audit", label: "سجل التدقيق" },
  { href: "/team", label: "فريق المنصة" },
  { href: "/docs", label: "توثيق الربط (API)" },
];

const ROLE = { owner: "مالك", admin: "مدير", viewer: "اطلاع" } as const;

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const session = await requireOperator();
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-ink p-5 text-slate-200">
        <p className="text-lg font-bold text-white">منصة الوكلاء</p>
        <p className="mb-6 text-xs text-slate-400">شمس أجا · بيئة معزولة</p>
        <nav className="space-y-1">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="block rounded-lg px-3 py-2 text-sm hover:bg-white/10">{item.label}</Link>
          ))}
        </nav>
        <div className="mt-10 border-t border-white/10 pt-4 text-xs text-slate-400">
          <p className="text-slate-200">{session.name}</p>
          <p>{ROLE[session.role]}</p>
          <form action={logoutAction} className="mt-3"><button className="text-slate-300 underline">خروج</button></form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8">{children}</main>
    </div>
  );
}
