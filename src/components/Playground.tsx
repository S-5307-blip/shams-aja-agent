"use client";

import { useState, useTransition } from "react";
import { playgroundAction } from "@/app/actions";

type Turn = { role: "user" | "assistant" | "error"; text: string; cost?: string };

/** Test chat with an agent from the dashboard. Each message uses the real model and costs tokens. */
export function Playground({ agentId }: { agentId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();

  function send(event: React.FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || pending) return;
    setText("");
    setTurns((current) => [...current, { role: "user", text: message }]);
    startTransition(async () => {
      const result = await playgroundAction(agentId, conversationId, message);
      if (result.error) {
        setTurns((current) => [...current, { role: "error", text: result.error! }]);
        return;
      }
      setConversationId(result.conversationId ?? null);
      setTurns((current) => [...current, { role: "assistant", text: result.reply ?? "", cost: result.cost }]);
    });
  }

  return (
    <div className="flex h-[32rem] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-line bg-slate-50 p-3">
        {turns.length === 0 && <p className="text-sm text-muted">اكتب رسالة كأنك عميل لتجربة الوكيل. التجربة تستخدم النموذج فعليًا وتُحسب تكلفتها على العميل.</p>}
        {turns.map((turn, index) => (
          <div key={index} className={turn.role === "user" ? "mr-auto max-w-[85%] rounded-lg bg-white p-3 text-sm shadow-sm" : turn.role === "error" ? "rounded-lg bg-red-50 p-3 text-sm text-red-800" : "ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-amber-50 p-3 text-sm"}>
            {turn.text}
            {turn.cost && <span className="mt-1 block text-xs text-muted">التكلفة التقديرية: {turn.cost}</span>}
          </div>
        ))}
        {pending && <p className="text-sm text-muted">الوكيل يكتب…</p>}
      </div>
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="رسالة تجريبية…" maxLength={8000} />
        <button className="btn" disabled={pending || !text.trim()}>إرسال</button>
        <button type="button" className="btn-ghost" onClick={() => { setTurns([]); setConversationId(null); }}>محادثة جديدة</button>
      </form>
    </div>
  );
}
