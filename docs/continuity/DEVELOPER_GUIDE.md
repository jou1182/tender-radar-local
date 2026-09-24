# دليل المطوّر — فهم منظومة رادار المنافسات

> للمطوّر البشري (أو الوكيل التقني) الذي يريد فهم **كيف** تعمل المنظومة من الداخل ليبني
> فوقها بلا رجوع للوراء. اقرأ أولًا [SSOT.md](SSOT.md) للحالة العامة، ثم هذا الملف للتفاصيل.

---

## 1. نظرة معمارية من فوق

المنظومة **محلية بالكامل** (local-first) وتتكون من 5 عمليات مستقلة:

```
┌─────────────┐   HTTP   ┌──────────────────┐
│ الواجهة      │─────────▶│ خدمة المزامنة      │
│ (vinext/Next)│   :4318  │ etimad-sync-svc   │
│   :3000      │◀─────────│  (كل الـendpoints) │
└─────────────┘          └───────┬──────────┘
                                 │ SQLite
                                 ▼
                     ┌───────────────────┐
                     │ .radar-data/       │
                     │   radar.sqlite     │
                     └───────────────────┘

┌────────────────────┐   CDP :9333   ┌────────────────────┐
│ Chrome البشري المخصص │◀─────────────│ جلسة Chrome        │
│ (تسجيل دخول يدوي)     │              │ radar-chrome-session│
└────────────────────┘              └────────────────────┘

┌─────────┐  :11434  ┌────────────┐   ┌──────┐  :5678
│ Ollama   │◀────────│ analysis    │   │ n8n  │ (جدولة ليلية)
│ (نماذج)  │         │ providers   │   └──────┘
└─────────┘         └────────────┘

┌────────────────────┐  :9333
│ نبضة keepalive      │ (تمرير+تحديث كل N ثانية)
└────────────────────┘
```

**القاعدة الذهبية:** الواجهة **لا تلمس SQLite مباشرة أبدًا**. كل شيء عبر خدمة 4318.
المصدر الوحيد للحقيقة التشغيلية = SQLite. المصدر الوحيد للحقيقة الكودية = Git.

## 2. دورة حياة المنصة (من الإقلاع للإغلاق)

المشغّل `scripts/start-radar.mjs` (يُستدعى عبر `npm run radar` أو `تشغيل-الرادار.cmd`):

1. يفحص إن كانت الخدمة (`/health` على 4318) والواجهة (3000) تعملان أصلًا.
2. إن وُجدت واجهة يتيمة (vinext عالق) يقتلها تلقائيًا.
3. يُقلع **ثلاث عمليات**:
   - خدمة المزامنة: `node scripts/etimad-sync-service.mjs`
   - الواجهة: `npm run start` (vinext)
   - **نبضة keepalive**: `node scripts/lib/session-keepalive.mjs`
4. عند SIGINT/SIGTERM: يقتل الثلاثة معًا.

> **ملاحظة حرجة:** جلسة Chrome المخصصة مفتوحة بـ`detached: true` — أي أنها **لا تموت
> مع الخدمة**. هذا إصلاح 2026-08-29 (كانت `detached:false` فتُغلق الجلسة مع كل إعادة إقلاع).

## 3. الخدمة (4318) — خريطة الـendpoints

كل المسارات في `scripts/etimad-sync-service.mjs`. أهمها:

| الطريقة | المسار | الوظيفة |
|---|---|---|
| GET | `/health` | صحة الخدمة + `state` + `browser.status` + schemaVersion |
| GET | `/status` | حالة المزامنة (`phase`) — **تقرأه النبضة لقفل التشابك** |
| POST | `/sync` | بدء مزامنة (تعيد استخدام `syncPromise` — لا مزامنة متوازية) |
| GET | `/tenders` | قائمة المنافسات |
| GET/POST | `/approval-intents` | إنشاء/تأكيد نية موافقة تنزيل |
| POST | `/approval-jobs/live` | تنفيذ تنزيل حي (يتطلب قائمة سماح env) |
| GET/POST | `/keepalive/interval` | قراءة/ضبط فترة النبضة (30–300 ث) |
| GET | `/dashboard/*` | لوحة القيادة (last-run/regions/storage) |
| POST | `/dashboard/storage/purge` | مسح المرفقات الأقدم من N يوم |
| GET | `/analysis/*` | صحة التحليل والمهام |
| GET/POST | `/agents*` | إدارة الوكلاء السبعة |

## 4. مسار التنزيل الحي (الأهم أمنيًا)

التنزيل الحي يمر بطبقات صارمة — **لا تتجاوز أي طبقة**:

```
1. نية موافقة (requestDownloadApprovalIntent)
   → تُسجَّل pending بمرجع+ملف+bصمة manifest
2. تأكيد بشري (confirmDownloadApprovalIntent)
   → يتطلب عبارة الموافقة الحرفية: "أوافق على تنزيل الملفات المحددة الآن من هذه المنافسة فقط"
   → ينتج approval صالح 10 دقائق لاستخدام واحد
3. تنفيذ (adapter.execute في live-attachment-acquisition.mjs)
   → يفحص قائمة السماح (env vars) ← من بيئة الإقلاع
   → preflight عبر السائق (etimad-live-driver.mjs) ← يتأكد أن الصفحة والملف يطابقان
   → acquire: fetch داخلي بنفس جلسة Chrome ← base64 عبر CDP
   → حجر quarantine ← فحص توقيع/امتداد/MIME/SHA-256 ← نقل ذري (hard-link)
   → markAttachmentDownloaded
```

**قائمة السماح env vars (تُضبط عند الإقلاع، لا في سكربت):**
```
RADAR_LIVE_DOWNLOAD_ENABLED=true
RADAR_LIVE_DOWNLOAD_TENDER_REF=<المرجع>
```

**P5-LIVE-ALLOWLIST-TENDER (2026-09-16):** قائمة السماح تكتفي بمرجع منافسة واحد
— لم يعد اسم الملف أو بصمة manifest يُصرَّح بهما مسبقًا عند الإقلاع (كانا
`RADAR_LIVE_DOWNLOAD_FILE_NAME`/`RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256`، أُزيلا).
أي ملف داخل المنافسة المسموحة يُقبل الآن دون إعادة إقلاع للخدمة، بشرط موافقة
بشرية صريحة منفصلة (عبارة الرضا + بصمة manifest **لكل طلب فعلي**) عبر
`download-gate.mjs` — هذا الحارس الحقيقي لم يتغيّر. التنفيذ الحي يبقى ملفًا
واحدًا لكل استدعاء `execute()` (قيد معماري في السائق/الحجر/الفحص، تفرضه
`assertSingleFileManifest`، لا علاقة له بقائمة السماح).

> **دين تقني موثّق (محلول):** التنزيل الثاني (جدول الكميات) مرّ بمسار أضعف مؤقتًا
> (allowlist من سكربت). صُحّح بإعادة إقلاع الخدمة بقائمة السماح كـenv vars. لا تكرّر هذا.

## 5. مسار التحليل الحي (P5-B1 + RTL-2)

```
1. مستند موثوق (analysis_documents) ← placeTrustedDocument أو createJobFromStoredDocument
2. استخراج نصي حتمي (analysis-documents.mjs):
   - فك PDF/XLSX/DOCX بلا مكتبات خارجية ثقيلة
   - فك ToUnicode CMap لخطوط CID (النص العربي الحقيقي) ← buildCidMaps
   - تطبيع NFKC (أشكال العرض → حروف قياسية)
   - fixArabicVisualOrder (RTL-2): عكس ترتيب الكلمات + إبقاء اللاتيني + إصلاح لام-ألف
3. تقسيم + كتالوج أدلة حرفية (cand- معرفات SHA-256)
4. النموذج (nemotron عبر Ollama loopback) يختار معرفات فقط
5. بناء تقرير canonical + تحقق grounding صارم (بلا إعادة محاولة — عقد P4-A1R)
```

**مفتاح RTL-2 (لا تكسره):** يُطبَّق فقط عندما `cidMaps.size > 0` و`applyRtlFix=true`؛
ملفات benchmark تمرر `applyRtlFix:false` لحماية بصمتها.

## 6. قاعدة البيانات — الجداول الحرجة

`schemaVersion: 10`. الجداول الأساسية في `radar-repository.mjs`:

| الجدول | الغرض |
|---|---|
| `tenders` | المنافسات (metadata) |
| `tender_details` | تفاصيل الصفحة (المصدر الموثوق لقيمة الكراسة) |
| `attachments` | أسماء المرفقات وحالاتها |
| `download_queue` / `download_jobs` | طابور ومهام التنزيل |
| `approval_intents` / `approvals` | نوايا وموافقات التنزيل |
| `analysis_documents` / `analysis_jobs` / `analysis_evidence` | التحليل |
| `agents` / `agent_activity` | الوكلاء السبعة |
| `tender_classification` | التصنيف الحتمي |
| `policy_settings` | إعدادات (منها `keepaliveIntervalSeconds`) |
| `sync_runs` / `sync_checkpoints` / `sync_observations` | المزامنة |

## 7. نبضة keepalive — كيف تعمل بالضبط

`scripts/lib/session-keepalive.mjs`:

1. حلقة لا نهائية ذكية:
   - بعد نبضة ناجحة: فاصل زمني متغير عشوائيًا (بين 60 و300 ثانية، بخطوة 15ث) يحاكي السلوك البشري ويمنع كشف الأنماط الآلية.
   - عند انشغال الخدمة (مزامنة/تنزيل حي): انتظار قصير 30ث للتحقق مجددًا بعد انتهاء العملية دون إحداث فجوة خمول مفرطة.
   - عند عدم العثور على صفحة اعتماد: فحص سريع كل 15ث حتى يفتح المستخدم المتصفح.
2. `pulse()`:
   - يفحص قفل التشابك: يقرأ `/status` → إن كان `phase` في `{starting,scanning,resuming,captcha-required,login-required}` أو `downloading === true` يتخطى.
   - يجد صفحة اعتماد عبر CDP `:9333/json/list`.
   - يرسل تمريرًا خفيفًا + `Page.reload`.
3. `currentIntervalMs()`: يحسب الفاصل الزمني العشوائي للدورة التالية ضمن سقف الفترة المضبوطة في الخدمة (60–300ث) — **التغيير يسري فورًا**.

**حدود الفترة:** 30–300 ثانية (مطبقة في `radar-repository.mjs` `setKeepaliveInterval`).

## 8. الاختبارات — الحقيقة المطلقة

- `npm test` = **371/371** (القائمة المعتمدة في `package.json`).
- `node --test tests/*.test.mjs` يشمل اختبارات إضافية (p5keepalive، rtl2، p5agents…) وقد
  يُظهر خطأ عزل node:test عند التوازي — **ليس فشل منطق**.
- **قاعدة الاختبارات:** لا تلمس قاعدة التشغيل؛ تستخدم `mkdtemp` لقواعد مؤقتة.
- **قاعدة benchmark:** fixtures اصطناعية ببصمة مجمدة في `benchmark/runtime-freeze.json` —
  أي تعديل على ملفات التحليل يتطلب إعادة توليد البصمة.

## 9. كيف تضيف ميزة جديدة (المسار الصحيح)

1. اقرأ `SSOT.md` ← حدد الـcommit الأساس الكامل.
2. أنشئ worktree معزول: `git worktree add -b alt/xxx ../radar-alt-xxx HEAD`.
3. نفّذ الكود + الاختبارات في الـworktree.
4. شغّل `npm test` في الـworktree ← يجب 371/371 (أو أكثر إن أضفت اختبارات).
5. قدّم تقريرًا للمشرف **خارج Git** (لا تلتزم التقرير داخل المستودع).
6. بعد موافقة المالك، ادمج إلى main.

> **مهم:** أي قدرة حساسة (تنزيل حي، تحليل حي، اتصال خارجي) تتطلب **موافقة صريحة جديدة
> في نفس الجلسة** — لا تُفعَّل ضمنيًا أبدًا.

## 10. أخطاء شائعة وقعنا فيها (لا تكررها)

| الخطأ | الدرس |
|---|---|
| فتح Chrome بـ`detached:false` | الجلسة تموت مع الخدمة — اجعلها `detached:true` |
| بناء allowlist في سكربت | يجب أن تأتي من بيئة الإقلاع (env vars) |
| النبضة تنهار على `ECONNREFUSED` | احصر كل fetch لـCDP بـtry/catch |
| مطابقة أسماء عربية بلا تطبيع | طبّع `ة→ه` و`أ→ا` على **الطرفين** |
| عكس السلسلة كاملة للعربية | اعكس ترتيب الكلمات فقط + أبقِ اللاتيني |
| قراءة `evidenceCatalog` بدل `sufficiencyEvidenceIds` (اسم سابق: `decisionEvidenceIds` قبل P5-EVIDENCE-SUFFICIENCY) | الأدلة الفعلية في `sufficiencyEvidenceIds` |
| الثقة برقم من محادثة قديمة | شغّل `npm test` واقرأ `SSOT.md` |
