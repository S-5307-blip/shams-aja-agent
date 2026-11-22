# وكيل عمليات المكتب — دليل التشغيل والتطوير

## البنية
```
src/ops/
  config.js          الإعدادات من متغيرات البيئة
  db.js, migrate.js  SQLite + ترحيلات مرقمة من migrations/
  store.js           طبقة البيانات (كل استعلام مقيد بـ tenant_id)
  permissions.js     الأدوار والصلاحيات
  validate.js        التحقق من مدخلات الأدوات
  dates.js           التواريخ: توقيت المكتب، الهجري (أم القرى)، فروق الأيام
  workflow.js        حالات المعاملة والانتقالات المسموحة
  kb/index.js        تحميل قاعدة المعرفة والبحث فيها
  tools/definitions.js  تعريف الأدوات
  tools/index.js     المنفّذ: صلاحيات، تحقق، مهلة، منع تكرار، اعتماد، تسجيل
  followups.js       المتابعة الآلية (قواعد ثابتة)
  messages.js        نصوص التذكيرات
  channels/          قنوات الإرسال (manual, whatsapp)
  llm/               موفّرو النموذج (anthropic, mock)
  prompt.js          تعليمات النظام
  agent.js           حلقة الوكيل
  app.js, server.js  واجهة HTTP
public/ops/          الواجهة الرسومية
knowledge/           قاعدة المعرفة (انظر knowledge/README.md)
migrations/          ترحيلات قاعدة البيانات
n8n/                 مثال سير عمل n8n للمتابعة اليومية
```

**لماذا هذه البنية:** المشروع كان Node.js + Express + SQLite + Claude، فبُني الوكيل الجديد على نفس التقنيات دون إطار إضافي ودون مكتبات جديدة. الوكيل مستقل عن وكيل واتساب (إعدادات وقاعدة بيانات منفصلتان) فلا يتأثر أحدهما بتعطل الآخر، ويمكن ربطهما لاحقاً.

## التشغيل محلياً
```bash
npm install
cp .env.example .env            # ثم ضع ANTHROPIC_API_KEY (أو LLM_PROVIDER=mock للتجربة بلا مفتاح)
npm run ops:migrate             # ينشئ الجداول (ويأخذ نسخة احتياطية إن وُجدت قاعدة)
npm run ops:seed                # بيانات تجريبية وهمية + رموز دخول في data/dev-tokens.json
npm run ops:followups           # تشغيل المتابعة الآلية مرة
npm run ops:dev                 # http://localhost:3100/ops/
npm test                        # كل الاختبارات (نموذج محاكى، بلا مفاتيح)
```
ادخل بالواجهة برمز `demo1_manager` (يعتمد) أو `demo1_staff` (يقترح فقط).

## الأدوار
| الدور | يقرأ | يكتب مهام/ملاحظات/تذكيرات | يعتمد الإجراءات | يشغّل المتابعة | سجل التدقيق |
|---|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | ✓ | ✓ | ✓ | ✓ |
| staff | ✓ | ✓ | ✗ | ✗ | ✗ |
| viewer | ✓ | ✗ | ✗ | ✗ | ✗ |
| automation | ✗ | ✗ | ✗ | ✓ | ✗ |

## حالات الإجراء
`proposed` مقترح ← `pending_approval` ينتظر اعتماداً ← `executing` جارٍ التنفيذ ← `succeeded` نجح / `failed` فشل، أو `rejected` مرفوض.
حالات التذكير: `pending_approval`، `sending`، `sent` (قبله مزود القناة)، `queued_manual` (جاهز للإرسال اليدوي؛ لا يُعتبر مرسلاً حتى يضغط الموظف «أرسلته»)، `failed`، `cancelled`، `skipped`.

## واجهة HTTP (كلها بـ `Authorization: Bearer <token>`)
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/agent/ask` | `{ request, request_id }` — نفس `request_id` يعيد النتيجة المحفوظة دون تنفيذ جديد |
| GET | `/api/clients?q=` · `/api/clients/:id` | العملاء |
| POST | `/api/clients` · `/api/clients/:id/documents` · `/api/transactions` | إدخال بيانات (التاريخ ميلادي أو `expiry_calendar: "hijri"`) |
| POST | `/api/documents/:id/renew` | تاريخ انتهاء جديد مع `data_source` — يلغي تذكيرات التاريخ القديم |
| GET | `/api/documents/expiring?days=60` | الانتهاءات |
| GET | `/api/actions?status=pending_approval` | الإجراءات |
| POST | `/api/actions/:id/approve` · `/reject` | الاعتماد (مدير/مالك) |
| GET/POST | `/api/tasks` · `/api/tasks/:id/complete` | المهام |
| GET/POST | `/api/reminders` · `/api/reminders/:id/mark-sent` | التذكيرات |
| POST | `/api/automation/followups` | المتابعة الآلية (n8n/cron) |
| GET | `/api/audit?run_id=` | سجل التدقيق |

## تغيير النموذج
- غيّر `LLM_MODEL` فقط؛ لا يتغير منطق العمل.
- الافتراضي `claude-opus-5-5` ($4 / $20 لكل مليون رمز إدخال/إخراج) بجهد `medium`: الأفضل في اتباع قواعد الأدوات والاعتماد والاستشهاد، وهو أهم من فرق التكلفة في عمل يمس عملاء ومواعيد نظامية.
- بديل أرخص: `claude-sonnet-5-5` ($2 / $10)، ثم `claude-haiku-5-5` ($0.10 / $0.50) لطلبات القراءة البسيطة. قبل التبديل شغّل مجموعة طلبات حقيقية وقارن.
- التعليمات ثابتة وتُخزَّن مؤقتاً (prompt caching)، فتكلفة الطلبات المتتالية أقل.
- `LLM_REFUSAL_FALLBACK=default`: إن رفض النموذج طلباً لأسباب السلامة يعيده الخادم على نموذج احتياطي تلقائياً.
- **موفّر آخر:** أنشئ `src/ops/llm/<name>.js` يصدّر `chat({ system, messages, tools }) → { content, stop_reason, usage, model }` بصيغة كتل Messages API (`text`, `tool_use`, `tool_result`)، وسجّله في `src/ops/llm/index.js`، ثم `LLM_PROVIDER=<name>`.

## إضافة أداة
1. أضف تعريفاً في `src/ops/tools/definitions.js`:
   ```js
   {
     name: 'my_tool',
     description: 'ماذا تفعل ومتى تُستخدم',
     permission: 'read' | 'task.write' | ... (permissions.js),
     mode: 'read' | 'write' | 'approval',
     input_schema: { type: 'object', properties: {...}, required: [...], additionalProperties: false },
     run(ctx, input) { /* استخدم ctx.store مع ctx.tenantId فقط */ return { _status: 'done', ... }; },
     // لنمط approval: prepare(ctx, input) → { input, summary, idempotency_key } + منفّذ في HANDLERS (tools/index.js)
   }
   ```
2. ارمِ `OpsError(code, رسالة مفهومة)` عند الفشل؛ المنفّذ يحولها لنتيجة `ok:false`.
3. للكتابة: استخدم `dedupe_key` لمنع التكرار.
4. أضف اختباراً في `test/tools.test.js` ومهارة في `docs/skills.md`.

## إضافة قناة تواصل
أنشئ `src/ops/channels/<name>.js` يصدّر `{ name, send(reminder, { client }) }` يرجع `{ status: 'sent' | 'queued_manual', provider_message_id? }` أو يرمي `OpsError`، وسجّله في `channels/index.js`. لا تُرجع `sent` إلا بتأكيد من المزود.

## الترحيلات
- لا تعدّل ملف ترحيل طُبّق. أضف ملفاً جديداً `migrations/002_وصف.sql` بتغييرات إضافية فقط (`ALTER TABLE ... ADD COLUMN`، جداول جديدة).
- `npm run ops:migrate` يأخذ نسخة احتياطية `*.bak-<timestamp>` قبل التطبيق، ويطبق الجديد فقط داخل معاملة.
- الخادم يطبق الترحيلات الجديدة تلقائياً عند الإقلاع.

## الأتمتة (n8n أو cron)
- n8n: استورد `n8n/daily-followups.json`، واضبط `OPS_BASE_URL` ورمز مستخدم بدور `automation`.
- بدون n8n: `npm run ops:followups` من cron يومياً (مثلاً 7:17 صباحاً بتوقيت الرياض).
- التشغيل آمن للتكرار، ولا يرسل شيئاً للعملاء: يجهز تذكيرات تنتظر الاعتماد ومهاماً داخلية.
