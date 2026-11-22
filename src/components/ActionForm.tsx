"use client";

import { startTransition, useActionState } from "react";
import type { FormState } from "@/app/actions";

type Props = {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  children: React.ReactNode;
  submit: string;
  className?: string;
};

/**
 * A form bound to a server action, with its pending state and result message. It submits through
 * onSubmit rather than the `action` prop so React does not clear the fields afterwards: a
 * validation error must not wipe a long prompt the operator just wrote.
 */
export function ActionForm({ action, children, submit, className }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form
      className={className ?? "space-y-4"}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      {children}
      {state?.key && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="mb-2 font-semibold">انسخ المفتاح الآن، لن يظهر مرة أخرى:</p>
          <code className="block select-all break-all rounded bg-white p-2 text-xs">{state.key}</code>
        </div>
      )}
      {state?.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state?.ok && !state.key && <p className="text-sm text-emerald-700">{state.ok}</p>}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "جارٍ التنفيذ…" : submit}
      </button>
    </form>
  );
}
