# Agents API — دليل الربط

يُرسل هذا الملف لفريق العميل التقني. استبدل `https://AGENTS_DOMAIN` بالرابط الفعلي للمنصة.

## المصادقة / Authentication

كل طلب يحمل مفتاح العميل في الترويسة:

```
Authorization: Bearer sak_live_...
```

(أو `x-api-key: sak_live_...`). احفظ المفتاح في خادمكم فقط، ولا تضعه في تطبيق جوال أو صفحة ويب يراها المستخدم.

## إرسال رسالة / Send a message

`POST /api/v1/chat`

```bash
curl https://AGENTS_DOMAIN/api/v1/chat \
  -H "Authorization: Bearer sak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "AGENT_ID",
    "message": "What are your working hours?",
    "user_ref": "customer-123"
  }'
```

| الحقل | مطلوب | الوصف |
|---|---|---|
| `agent_id` | إلا إذا كان المفتاح مقيدًا بوكيل | معرّف الوكيل |
| `message` | نعم | رسالة المستخدم، حتى 8000 حرف |
| `conversation_id` | لا | لمتابعة محادثة سابقة؛ اتركه فارغًا لبدء محادثة جديدة |
| `user_ref` | لا | معرّفكم للمستخدم النهائي (حتى 200 حرف) للمتابعة والتقارير |

الرد:

```json
{
  "conversation_id": "cm...",
  "reply": "We are open 9 am to 5 pm, Sunday to Thursday.",
  "truncated": false,
  "usage": { "input_tokens": 1830, "output_tokens": 212 }
}
```

- أعد إرسال `conversation_id` مع كل رسالة تالية في نفس المحادثة. الوكيل يتذكر ما سبق.
- المحادثة الواحدة حدها 100 رسالة؛ بعدها يرجع `conversation_full` وتبدأون محادثة جديدة.
- لا ترسلوا رسالتين في نفس المحادثة في الوقت نفسه؛ انتظروا الرد (`conversation_busy`).
- قد يستغرق الرد عدة ثوانٍ. اجعلوا مهلة الطلب لديكم 120 ثانية على الأقل.

## نقاط أخرى

`GET /api/v1/agents` — الوكلاء المتاحون لهذا المفتاح:

```json
{ "data": [{ "id": "cm...", "name": "Support assistant", "description": "..." }] }
```

`GET /api/v1/conversations/{id}` — رسائل محادثة:

```json
{ "id": "cm...", "agent_id": "cm...", "user_ref": "customer-123", "created_at": "...",
  "messages": [{ "role": "user", "text": "...", "created_at": "..." }, { "role": "assistant", "text": "...", "created_at": "..." }] }
```

## الأخطاء / Errors

كل خطأ بالشكل:

```json
{ "error": { "code": "rate_limited", "message": "..." } }
```

| HTTP | code | المعنى وماذا تفعلون |
|---|---|---|
| 400 | `invalid_request` | الطلب ناقص أو الرسالة طويلة. صححوا الطلب. |
| 401 | `unauthorized` | المفتاح مفقود أو خطأ أو ملغى. |
| 402 | `budget_exceeded` | وصل حسابكم لسقفه الشهري. تواصلوا معنا لرفعه. |
| 403 | `tenant_suspended` / `forbidden` | الحساب موقوف، أو المفتاح مقيد بوكيل آخر. |
| 404 | `agent_not_found` / `conversation_not_found` | المعرّف غير موجود في حسابكم. |
| 409 | `agent_inactive` | الوكيل غير مفعّل حاليًا. |
| 409 | `conversation_full` | ابدأوا محادثة جديدة دون `conversation_id`. |
| 409 | `conversation_busy` | رد سابق لم ينته. انتظروا ثم أعيدوا. |
| 422 | `refused` | لا يستطيع الوكيل المساعدة في هذا الطلب. |
| 429 | `rate_limited` | طلبات كثيرة في الدقيقة. أعيدوا بعد دقيقة. |
| 502 | `upstream_error` | تعذر الرد مؤقتًا. أعيدوا المحاولة بعد ثوانٍ. |
| 503 | `not_configured` | المنصة قيد التهيئة. |

الأخطاء 429 و502 و`conversation_busy` آمنة لإعادة المحاولة: الرسالة الفاشلة لا تُحفظ في المحادثة.

## مثال Node.js

```js
const res = await fetch("https://AGENTS_DOMAIN/api/v1/chat", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.AGENTS_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ agent_id: process.env.AGENT_ID, message: userText, conversation_id: savedConversationId }),
  signal: AbortSignal.timeout(120_000),
});
const data = await res.json();
if (!res.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
savedConversationId = data.conversation_id;
```

## الخصوصية

- رسائل المستخدمين وردود الوكيل تُحفظ في قاعدة بيانات المنصة لتشغيل المحادثة ومراجعة الجودة.
- لا ترسلوا للوكيل أرقام هويات أو بيانات بطاقات أو كلمات مرور.
- تُعالج الرسائل عبر Claude من Anthropic.
