# النشر على Railway (مشروع منفصل)

المنصة تُنشر في **مشروع Railway جديد** لا يشارك أي خدمة أو قاعدة بيانات أو متغيرات مع مشروع موقع المكتب.

## 1. مفتاح Claude مستقل

في [Anthropic Console](https://platform.claude.com) أنشئ Workspace جديدًا باسم مثل `client-agents`، ثم أنشئ مفتاح API داخله. هكذا:

- تكلفة وكلاء العملاء تظهر منفصلة عن سلمى والمكتب.
- يمكن وضع حد إنفاق شهري على هذا الـ Workspace وحده من إعدادات Console.
- إلغاء هذا المفتاح لا يوقف شغل المكتب، والعكس.

## 2. المشروع والقاعدة

1. Railway ← New Project ← Deploy from GitHub repo ← `shams-aja-agent`.
2. في نفس المشروع: New ← Database ← PostgreSQL.
3. في خدمة التطبيق ← Variables:

| المتغير | القيمة |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (مرجع لقاعدة هذا المشروع فقط) |
| `AUTH_SECRET` | ناتج `openssl rand -base64 48` |
| `ANTHROPIC_API_KEY` | مفتاح الخطوة 1 |
| `APP_URL` | الرابط العام بعد توليده، مثل `https://agents.shmsaja.sa` |

4. Settings ← Networking ← Generate Domain (أو ربط نطاق فرعي مثل `agents.shmsaja.sa`).

البناء يستخدم `Dockerfile` و`railway.json`. عند كل تشغيل تُطبّق الترحيلات (`prisma migrate deploy`) ثم يبدأ الخادم، وفحص الصحة على `/api/health`.

## 3. أول حساب مالك

من جهازك، بعد تثبيت Railway CLI وربطه بالمشروع الجديد:

```bash
railway run --service <app-service> sh -c 'BOOTSTRAP_OWNER_NAME="الاسم" BOOTSTRAP_OWNER_EMAIL="you@example.com" BOOTSTRAP_OWNER_PASSWORD="كلمة-مرور-قوية-12+" npm run bootstrap:owner'
```

يرفض الأمر التنفيذ إذا كان هناك مالك. بقية الفريق تُضاف من صفحة «فريق المنصة».

## 4. قبل أول عميل

- [ ] `npm run check:env` يمر في بيئة الإنتاج.
- [ ] جرّب وكيلًا من صفحة «تجربة الوكيل».
- [ ] أنشئ مفتاحًا تجريبيًا ونفّذ مثال `curl` من `docs/api.md`، ثم ألغه.
- [ ] ضع سقفًا شهريًا لكل عميل يتناسب مع باقته.
- [ ] ضع حد إنفاق على Workspace المنصة في Anthropic Console.
- [ ] فعّل النسخ الاحتياطي لقاعدة PostgreSQL في Railway.
- [ ] راجع مع المحامي شروط الخدمة واتفاقية معالجة البيانات مع العملاء (المحادثات تُحفظ لدينا وتُعالج عبر Anthropic).

## ملاحظات تشغيل

- حد الطلبات في الدقيقة يُحسب من قاعدة البيانات، ويعمل صحيحًا مع أكثر من نسخة للخادم.
- إذا أعيد تشغيل الخادم أثناء رد، تُفك المحادثة تلقائيًا بعد 5 دقائق.
- لتغيير الأسعار التقديرية عدّل `src/lib/models.ts`.
