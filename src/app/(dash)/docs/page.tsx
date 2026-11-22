const BASE = (process.env.APP_URL || "https://agents.example.com").replace(/\/$/, "");

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-ink p-4 text-left text-xs leading-relaxed text-slate-100">{children}</pre>;
}

export default function DocsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="h1">توثيق الربط (API) — يُرسل لفريق العميل التقني</h1>
      <p className="text-sm text-muted">النسخة الكاملة القابلة للمشاركة في <code>docs/api.md</code> بالمستودع. كل طلب يحتاج مفتاحًا تنشئه من صفحة العميل.</p>

      <section className="card space-y-3">
        <h2 className="h2">1. إرسال رسالة للوكيل</h2>
        <Code>{`curl ${BASE}/api/v1/chat \\
  -H "Authorization: Bearer sak_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "AGENT_ID",
    "message": "كم مدة تجديد الإقامة؟",
    "user_ref": "customer-123"
  }'`}</Code>
        <p className="text-sm">الرد:</p>
        <Code>{`{
  "conversation_id": "cm...",
  "reply": "...",
  "truncated": false,
  "usage": { "input_tokens": 1830, "output_tokens": 212 }
}`}</Code>
        <p className="text-sm">لمتابعة نفس المحادثة أرسل <code>conversation_id</code> مع الرسالة التالية. إذا كان المفتاح مقيدًا بوكيل واحد فلا حاجة لـ <code>agent_id</code>.</p>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">2. نقاط أخرى</h2>
        <Code>{`GET ${BASE}/api/v1/agents                 # الوكلاء المتاحون لهذا المفتاح
GET ${BASE}/api/v1/conversations/{id}     # رسائل محادثة`}</Code>
      </section>

      <section className="card">
        <h2 className="h2 mb-3">3. رموز الأخطاء</h2>
        <table className="table">
          <thead><tr><th>HTTP</th><th>code</th><th>المعنى</th></tr></thead>
          <tbody>
            {[
              ["401", "unauthorized", "المفتاح مفقود أو غير صحيح أو ملغى"],
              ["400", "invalid_request", "الطلب ناقص أو الرسالة أطول من 8000 حرف"],
              ["403", "tenant_suspended / forbidden", "الحساب موقوف، أو المفتاح مقيد بوكيل آخر"],
              ["404", "agent_not_found / conversation_not_found", "غير موجود لهذا الحساب"],
              ["409", "agent_inactive / conversation_full / conversation_busy", "الوكيل لا يعمل، أو المحادثة امتلأت (ابدأ جديدة)، أو رد سابق لم ينته"],
              ["402", "budget_exceeded", "وصل الحساب لسقفه الشهري"],
              ["429", "rate_limited", "طلبات كثيرة في الدقيقة"],
              ["422", "refused", "الوكيل لا يستطيع المساعدة في هذا الطلب"],
              ["502 / 503", "upstream_error / not_configured", "تعذر الرد مؤقتًا؛ أعد المحاولة"],
            ].map(([status, code, meaning]) => (
              <tr key={code}><td>{status}</td><td><code className="text-xs">{code}</code></td><td>{meaning}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
