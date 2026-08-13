# تقرير Kimi — P3-A: تعدد الأنشطة وتهيئة مركز المرفقات

- الفرع: `kimi/p3-multiactivity`
- نقطة الأساس: `4f4fed1` (P0 + P1 + P2)
- لم يُنفَّذ أي merge أو rebase إلى `main`، ولم تُلمس مجلدات `radar` أو `radar-kimi` القديمة.
- لم يُشغَّل Chrome حي، ولم تبدأ أي مزامنة، ولم يُنزَّل أو يُشترَ أي ملف.

## 1) إصلاح جودة P2 (إلزامي قبل P3-A)

### أ. اكتشاف أسماء ZIP/RAR/7Z

- أضيف في `scripts/lib/etimad-detail-parser.mjs`:
  - `isVisibleAttachmentName(text)`: يقبل `.pdf/.xls/.xlsx/.doc/.docx/.ppt/.pptx/.zip/.rar/.7z` مع الكلمات الدلالية، ويستبعد تسميات الإجراءات («تحميل الملف»، «ملفات داعمة»، «المرفق»، «شراء…»، «انضمام…»).
  - `selectVisibleAttachmentNames(candidates)`: يفك ترميز `fileName` بأمان ويختار النص الظاهر أو اسم الملف.
- في `scripts/etimad-sync-service.mjs` أصبح المتصفح يستخرج المرشحين الخام فقط (`text` + `fileName`)، والفلترة تتم في Node بالدالة المشتركة — **أسماء فقط، دون نقر على الملفات أو تنزيلها**.
- Fixture: `tests/fixtures/visible-attachment-candidates.fixture.json` (يحتوي «المخططات.zip» و«مرفقات المنصة.zip» من الدفعة الحية).

### ب. معيار الاكتمال مع retry واحد محدود

- `assessDetailCompleteness({ visibleTabCount, sectionsRead })`: إذا كانت التبويبات ظاهرة فالمتوقع = عدد التبويبات + 1 (اللوحة الأولى)؛ النقص يعني `partial` بسبب عربي واضح، لا `complete`. بلا تبويبات ظاهرة تبقى القراءة `complete` كما كانت.
- `shouldRetryDetailRead({ ..., alreadyRetried })`: محاولة واحدة فقط، ولا تعمل بلا تبويبات ظاهرة.
- `buildDetailRecord` يقبل الآن `visibleTabCount` ويحسب `status` و`errorMessage` (متوافق رجعيًا: بدونه يبقى `complete`).
- الخدمة تعيد قراءة التبويبات الناقصة مرة واحدة بعد انتظار قصير ثم يحسم السجل النهائي.
- Fixture: `tests/fixtures/partial-detail-tabs.fixture.json` (5 تبويبات ظاهرة، قُرئ قسمان أولًا).
- الملفات الجديدة للاختبارات: `tests/details-p2-quality.test.mjs` (5 اختبارات سلوكية).

## 2) Schema v4 (migration آمنة)

في `scripts/lib/radar-repository.mjs` (`migrationVersion = 4`):

| الجدول | الغرض |
|---|---|
| `activity_catalog` | 19 نشاطًا أساسيًا (`id` ثابت، `etimad_value` nullable، `name_ar` فريد، `source` = seed/etimad-visible/user، `active`، `first_seen_at`، `last_seen_at`) |
| `sub_activity_catalog` | الأنشطة الفرعية بمفتاح أجنبي + `UNIQUE(activity_id, name_ar)` لمنع التكرار داخل النشاط |
| `search_profiles` | الاسم، النشاط الأساسي، الأنشطة الفرعية، المناطق، حالات المنافسة، `fee_min/fee_max`، `target_per_region` (CHECK بين 1 و100)، `enabled`، تواريخ الإنشاء/التحديث |
| `attachments` (توسعة) | `availability` (metadata-only / free-available / purchased-available / restricted / unknown)، `requires_approval` = 1 افتراضيًا، `availability_updated_at` |

- ترقية v3→v4 عبر `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN` محروس بفحص `PRAGMA table_info` — لا فقدان للمنافسات أو التفاصيل الحية (مغطى باختبار يبني قاعدة v3 فعلية ثم يفتحها بكود v4 ويعيد فتحها).
- البذر idempotent من `scripts/lib/activity-catalog-seed.mjs` (قابل للتحديث، خارج JSX).
- الملف الافتراضي `profile-default` («النطاق الحالي — المقاولات»): 13 منطقة، النشطة، 0–600، حد 100 لكل منطقة، `enabled=1`.
- التقاط أسماء المرفقات يعيّن `metadata-only` فقط عندما تكون الحالة `unknown`، ولا يُنزّل حالة معروفة أبدًا.
- لا تُخزَّن أي بيانات دخول أو جلسات في SQLite.

## 3) طبقة الخدمة

- `GET /catalog/activities`، `GET /search-profiles`، `POST /search-profiles`، `PUT /search-profiles/:id` (CORS أضيف له PUT).
- تحقق آمن: رفض نشاط فرعي غير معروف (`INVALID_PROFILE` → 400)، منع تكرار الاسم، إسقاط معرفات مناطق غير صالحة، سقف 100 لكل منطقة، `fee_max >= fee_min`، وملف واحد مفعّل فقط.
- `serviceVersion = p3-multiactivity-1` ومطابقته في `scripts/start-radar.mjs`.

## 4) sync-plan يقبل Search Profile

- `defaultPlan` يعيد نطاق P1 تمامًا (المقاولات، قيمة اعتماد `2`، 13 منطقة، فئتا الرسوم، حد 100، 0–600).
- `planFromSearchProfile(profile)`: مناطق الفرعية حسب الملف، فئات الرسوم من `fee_min/fee_max`، سقف 100، `activityValue` من `etimad_value` أو `2` للمقاولات، و`null` لغيرها (لا توسع تلقائي لـ19 نشاطًا).
- `initialCursor/normalizeCursor/advanceCursor` تقبل `plan` اختياريًا — السلوك الافتراضي لم يتغير (اختبار يطابق تسلسل المؤشر بين الخطتين خطوة بخطوة).
- `performSync` يقرأ الملف المفعّل من SQLite؛ `applyFilters` يمرر قيمة النشاط فقط عند توفرها.

## 5) الواجهة (`app/page.tsx`)

- حُذفت المصفوفات الثابتة `activityOptions` و`subActivityOptions`؛ الكتالوج وملفات البحث تُقرأ من الخدمة/SQLite، مع رسالة إرشاد عند توقف الخدمة.
- النشاط الفرعي معطّل حتى اختيار الأساسي، ويدعم اختيارًا متعددًا (chips مع `aria-pressed`)؛ القطاعات الأخرى تعرض «لا توجد أنشطة فرعية مؤكدة بعد».
- لوحة «ملفات البحث المحفوظة»: تطبيق الملف على المعايير، حفظ الحالية (POST)، وتفعيل واحد للمزامنة (PUT).
- بطاقة «مركز المرفقات» لكل منافسة: قيمة الكراسة، حالة الإتاحة، أسماء المرفقات الظاهرة، هل يلزم شراء سابق في اعتماد، العبارة الصريحة «لا تنزيل قبل موافقة المستخدم»، وزر **disabled** «سيُفعّل في P3-B بعد الموافقة». لا يوجد أي زر أو مسار تنزيل/شراء/دفع فعلي.

## 6) الاختبارات ومعايير القبول

- `tests/catalog-p3.test.mjs`: 9 اختبارات تغطي البنود 1–8 (migration v3→v4، 19 نشاطًا بلا تكرار، فرعية المقاولات فقط، حفظ/قراءة/تعديل الملفات، الملف الافتراضي = نطاق P1، تغيّر الفرعية مع النشاط، حالات الإتاحة دون مسار تنزيل، غياب مسار الشراء/الدفع/التنزيل، قراءة الواجهة من الخدمة).
- `tests/details-p2-quality.test.mjs`: البند 10 (ZIP/RAR/7Z تُحفظ، والقراءة الناقصة `partial`).
- النتائج:
  - `npm test` → **31/31 ناجحة** (تشمل `npm run build` واختبارات P0/P1/P2 القديمة دون تعديل معناها).
  - `npm run lint` → **نظيف بلا أخطاء**.
  - `npm run db:init` → `schemaVersion: 4`، جاهز.
- ملاحظة بيئية: النسخة الجديدة كانت بلا `node_modules`؛ نُفّذ `npm ci` (473 حزمة من package-lock دون تغيير أي ملف manifest).

## 7) ما لم يُنفَّذ (بقصد)

- أي تنزيل/شراء/دفع أو endpoint تحميل؛ تدفق P3-B التنفيذي مؤجل كما نصت المهمة.
- قراءة `etimad_value` الحقيقية للأنشطة من اعتماد (تبقى NULL إلى مرحلة لاحقة).
- أنشطة فرعية لغير المقاولات (تبقى فارغة حتى تُقرأ من المنصة أو يضيفها المستخدم).
- تحقق حي عبر Chrome — متروك لـCodex بعد المراجعة.

## 8) ملاحظات الدمج لـCodex

- `page.tsx` تغيّر شكل حالة النشاط الفرعي من `subActivity` (نص) إلى `subActivities` (مصفوفة) — راجع أي استهلاك خارجي قبل النقل.
- `buildDetailRecord` يقبل `visibleTabCount` جديدًا؛ الاستدعاءات القديمة تبقى `complete` كما كانت.
- `attachments` الموجودة قبل v4 تبقى `availability='unknown'` حتى تُحدَّث؛ الالتقاط الجديد يعيّن `metadata-only`.
