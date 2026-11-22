import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <h1 className="h1 mb-1">منصة وكلاء شمس أجا</h1>
        <p className="mb-6 text-sm text-muted">لوحة تشغيل وكلاء الذكاء الاصطناعي لعملاء الشركات</p>
        <ActionForm action={loginAction} submit="دخول">
          <div>
            <label className="label" htmlFor="email">البريد</label>
            <input className="input" id="email" name="email" type="email" autoComplete="username" required dir="ltr" />
          </div>
          <div>
            <label className="label" htmlFor="password">كلمة المرور</label>
            <input className="input" id="password" name="password" type="password" autoComplete="current-password" required dir="ltr" />
          </div>
        </ActionForm>
      </div>
    </main>
  );
}
