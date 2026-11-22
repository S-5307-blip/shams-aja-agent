# متطلبات النشر (وكيل العمليات)

> مستقل عن التطوير: كل ما سبق جُرّب محلياً بنموذج محاكى. هذه خطوات بيئة الإنتاج وما يلزمها.

## المتطلبات
- Node.js 22 أو أحدث (يحتاج دعم ICU الكامل للتقويم الهجري، وهو الافتراضي في Node الرسمي).
- قرص دائم لقاعدة SQLite (على Railway: Volume على `/data`).
- `ANTHROPIC_API_KEY` من console.anthropic.com (للإنتاج؛ لا يُكتب في الملفات).
- اختياري: `WA_ACCESS_TOKEN` و`WA_PHONE_NUMBER_ID` وقالب `renewal_reminder` معتمد من Meta لإرسال التجديدات عبر واتساب.

## Railway (خدمة ثانية في نفس المشروع)
1. أنشئ خدمة جديدة من نفس المستودع، وفي Settings → Start Command: `npm run ops`.
2. اربط نفس الـ Volume على `/data` (أو Volume مستقلاً).
3. Variables:
   - `OPS_DB_PATH=/data/ops.db`
   - `ANTHROPIC_API_KEY=...`، `LLM_PROVIDER=anthropic`، `LLM_MODEL=claude-opus-5-5`
   - `REMINDER_CHANNEL=manual` (غيّرها إلى `whatsapp` بعد اعتماد القالب واختباره)
   - لا حاجة لضبط المنفذ: الخادم يقرأ `PORT` الذي يعطيه Railway تلقائياً.
4. Generate Domain، ثم أنشئ المنشأة والمالك من Shell الخدمة:
   ```bash
   node scripts/create-user.js --tenant-name "شمس أجا للخدمات العامة" --name "<اسم المالك>" --role owner
   node scripts/create-user.js --tenant <tenant_id> --name "n8n" --role automation
   ```
   احفظ الرموز في مدير كلمات مرور؛ لا تُعرض مرة أخرى.
5. جدولة المتابعة: n8n (`n8n/daily-followups.json`) أو Railway Cron بـ `npm run ops:followups`.

## الأمان
- الواجهة تعمل عبر HTTPS (Railway يوفره). الرموز تُخزَّن مُجزّأة (SHA-256).
- لا تشغّل `ops:seed` على الإنتاج (يرفض التشغيل إن وُجدت منشآت إلا مع `--force`).
- سجل التدقيق يخفي الجوالات والهويات والأسرار؛ قاعدة البيانات نفسها تحتوي بيانات العملاء، فقيّد الوصول للـ Volume ونسخه الاحتياطية.
- لا تُحفظ أرقام الهويات كاملة (آخر ٤ أرقام فقط).

## قبل الإطلاق
- [ ] اعتماد المالك للبنود ذات `needs_approval` في `knowledge/` (مواعيد التذكير، السياسات التشغيلية، الإجراءات).
- [ ] التحقق من البنود `needs_verification` و`unverified` من المصادر الرسمية وتحديث `approval` و`checked_at`.
- [ ] تجربة ٢٠–٣٠ طلباً حقيقياً من الموظفين بالنموذج الحقيقي ومراجعة `/api/audit`.
- [ ] نسخ احتياطي دوري لملف `/data/ops.db`.
