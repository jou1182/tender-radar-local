# OPERATIONS_RUNBOOK — دليل التشغيل (توثيق فقط)

> هذا الملف يوثّق أوامر موجودة فعلًا في `package.json` وملفات المشروع — لا ينفّذ شيئًا.
> استخدم `<PROJECT_ROOT>` للدلالة على مجلد المشروع بدل أي مسار شخصي.

## المتطلبات المحلية

- Node.js ‏≥ 22.13 (ميدان `engines` في `package.json`).
- اعتماديات مثبتة مسبقًا (`node_modules` موجودة؛ عند الحاجة `npm ci` بحضور المالك).
- اختياريًا للتحليل المحلي: Ollama محلية على loopback، ولا سحب نماذج من هذا المشروع.

## تهيئة قاعدة البيانات

```sh
npm run db:init
```

- ينشئ/يحدّث `.radar-data/radar.sqlite` إلى schemaVersion الحالية (7) بمigrations آمنة.
- `.radar-data/` مستبعدة من Git.
- توليد migrations جديدة (عند تغيير مخطط مصرح به فقط): `npm run db:generate`.

## الاختبارات والبناء والفحص

```sh
npm test        # بناء + كل الاختبارات المحلية (143 عند الأساس الوظيفي P4-A1D0M؛ 155 بعد حزمة P4-H0)
npm run build   # بناء الإنتاج (vinext build)
npm run lint    # ESLint — يجب أن يخرج نظيفًا
```

> أعداد الاختبارات المرجعية موثقة في `docs/continuity/CURRENT_STATE.json` تحت
> `testBaselines`؛ العدد 143 يخص الأساس الوظيفي فقط ولا يُستخدم كعدد حالي للحزمة.

## تشغيل الرادار وإيقافه (الطريقة المعتمدة)

- **التشغيل**: نقرتان على `تشغيل-الرادار.cmd` (يفتح `http://localhost:3000` تلقائيًا)،
  أو `npm run radar` من `<PROJECT_ROOT>`. المشغّل `scripts/start-radar.mjs` يتحقق من نسخة
  الخدمة ويرفض تشغيل نسخة قديمة.
- **الإيقاف**: إغلاق نافذة التشغيل (نافذة المشغّل) — لا أوامر قتل خارجية.
- **خدمة المزامنة منفردة** (عند الحاجة للفحص): `npm run sync-service`.
- **واجهة التطوير**: `npm run dev`؛ **واجهة الإنتاج بعد البناء**: `npm start`.

## فحص الصحة محليًا

- الواجهة: فتح `http://localhost:3000/` — يجب أن تعرض الحالة أو رسالة القاعدة الفارغة.
- خدمة المزامنة: `GET http://127.0.0.1:4318/health` — يرد JSON صحة الخدمة.
- صحة التحليل: عبر نقطة `/analysis/health` في الخدمة نفسها (حالات stub/disabled/
  configured-unverified/available/unavailable/model-unavailable) — الجسّ عند الطلب فقط.

## النسخ الاحتياطي لـSQLite

1. أوقف الرادار (أغلق نافذة المشغّل) لضمان عدم وجود كتابة نشطة.
2. انسخ الملف `.radar-data/radar.sqlite` إلى مجلد نسخ احتياطي باسم يتضمن التاريخ، مثل:
   `radar-backup-<YYYY-MM-DD>.sqlite`.
3. احتفظ بالنسخ خارج `<PROJECT_ROOT>` أو في مجلد مستبعد من Git.

## استعادة نسخة احتياطية

1. أوقف الرادار تمامًا.
2. أعد تسمية الملف الحالي `.radar-data/radar.sqlite` إلى `radar.before-restore.sqlite`
   (احتفاظًا — لا حذف).
3. انسخ ملف النسخة الاحتياطية إلى `.radar-data/radar.sqlite`.
4. نفّذ `npm run db:init` ثم شغّل الرادار وتحقق من ظهور البيانات.
5. إن ظهر خلل، أعد الملف المحتفظ به مكانه.

## جلسة اعتماد المنتهية

- إذا انتهت الجلسة أثناء مزامنة: اضغط «فتح جلسة اعتماد»، سجّل الدخول بنفسك، ثم
  «استئناف المزامنة» — الخطة تكمل من نقطة التوقف المحفوظة.
- إذا ظهر CAPTCHA/Cloudflare: أكمله بنفسك في النافذة البشرية ثم استأنف.
- لا يجوز إبقاء الجلسة بنشاط مصطنع (انظر SAFETY_BOUNDARIES.md).

## Ollama أو n8n غير متاح

- **Ollama غير متاحة**: التحليل عبر المزود الافتراضي `stub` يستمر؛ مزود Ollama يفشل بأمان
  بكود `AI_PROVIDER_UNAVAILABLE` أو `model-unavailable` دون إعادة محاولة ودون سحب نموذج.
  لا تصلح الخدمة من داخل المشروع — شغّلها خارجيًا بحضور المالك أو ابقَ على stub.
- **n8n غير متاح**: لا أثر على الواجهة والمزامنة والتحليل؛ التكامل end-to-end لم يُفعّل بعد.

## عطل CUDA المتكرر عند تحميل النموذج (معروف، غير محلول من المنبع)

- **العرَض الحرفي** عند استدعاء `/api/generate` على ويندوز مع CUDA:

  ```
  CUDA error: shared object initialization failed
  ggml-cuda.cu:106: CUDA error
  llama-server process has terminated: exit status 0xc0000409
  (The system detected an overrun of a stack-based buffer in this application)
  [GIN] ... | 500 | POST "/api/generate"
  ```

- **السبب الجذري (مشخَّص)** — خلل معروف وغير محلول في `ggml-cuda`/llama.cpp على ويندوز مع
  CUDA: فشل **عشوائي في حجز الذاكرة المثبَّتة (pinned)** عند كل تحميل نموذج — لأن Ollama
  **يُعطِّل mmap افتراضيًا على ويندوز** (`disabling mmap for llama-server load by default
  reason=windows_cuda`) — مع مسار تراجع معطوب في ggml-cuda (silent CUDA_Host → CPU pinned
  fallback). **ليس نقص VRAM، ولا خللًا في مشروعنا أو النموذج.**
  - المراجع: [ollama/ollama#17380](https://github.com/ollama/ollama/issues/17380) (مفتوح —
    يطابق كرتنا RTX 5070 Ti ورسالة الخطأ حرفيًا، compute capability 12.0) و
    [ollama/ollama#17138](https://github.com/ollama/ollama/issues/17138) (مغلق "not planned" —
    نفس العرَض بلا إصلاح).
- **عابر غير متكرر**: التحميلات المتطابقة تنجح وتفشل بشكل غير حتمي؛ بعد أول فشل لا يتكرر
  عادةً ضمن نفس جلسة Ollama. لا علاقة له بالنموذج أو بسعة VRAM — شوهد فعليًا في مشروعنا
  **4 مرات** بمراجع موثقة: `P4-M0B2B`، `P4-M0B3`، `P4-M0B5`، `P4-N0B` (أدلة كل حالة
  محفوظة بمجلداتها وبصماتها في `radar-model-benchmarks/`).
- **ما لا يصلحه (مثبت تجريبيًا في upstream)**: تعديل `OLLAMA_GPU_OVERHEAD` أو
  `OLLAMA_CONTEXT_LENGTH` لا يغيّر شيئًا — أُعيد إنتاج العطل بهما وبقيم مختلفة في
  Issue #17380.
- **تحذير صريح**: **لا تُضبط `CUDA_MODULE_LOADING=EAGER` إطلاقًا** — تُسبب تجمّد اكتشاف
  الكرت تمامًا وتُسوّئ الوضع.
- **تخفيف يدوي — للمستخدم نفسه فقط (لا ينفّذه أي وكيل)**:
  1. زيادة حجم **page file** في ويندوز (نظام → إعدادات متقدمة → الأداء → الذاكرة
     الافتراضية) — يُقلص نافذة فشل الحجز المثبَّت.
  2. **تفريغ ذاكرة RAM** قبل أي تشغيل حي مهم (إغلاق البرامج غير الضرورية أو إعادة تشغيل
     الجهاز).
  3. إبقاء **مخزن نماذج Ollama على قرص NVMe سريع** لتقصير نافذة الخطر أثناء تحميل النموذج.
- **جملة صريحة**: هذا تخفيف احتمالية وليس حلًّا كاملًا؛ **لا يوجد إصلاح مضمون متاح حاليًا
  من جهة Ollama نفسها**. عند حدوث العطل في مهمة حية: سجّل النتيجة كما هي، لا retry، لا
  تخفيف للبوابات، وأعد المحاولة لاحقًا (جلسة Ollama جديدة) بقرارك.

## فشل تحليل أو grounding

- مهمة التحليل الفاشلة تسجل `errorCode` واضحًا (مثل `AI_OUTPUT_INVALID` أو
  `ANALYSIS_GROUNDING_FAILED` أو `AI_NO_EVIDENCE_CANDIDATES`) ولا تحفظ تقريرًا جزئيًا.
- لا retry تلقائي. راجع سجل `model_runs` للمهمة، وأعد إنشاء مهمة جديدة بعد معالجة السبب.
- لا تخفف المدقق ولا grounding لإنجاح مهمة فاشلة — التخفيف يحتاج مهمة مكتوبة ومراجعة.

## التراجع باستخدام Git دون أوامر مدمرة

- كل مرحلة معتمدة لها commit معروف في `docs/continuity/PHASE_LEDGER.md`.
- للتراجع عن دمج لم تبدأ مراجعته: أنشئ فرع فحص من الـcommit السابق واطلب مراجعة المشرف؛
  الوسيلة المعتمدة هي **commit عكسي (`git revert`) بمهمة مكتوبة** — لا `reset` ولا
  `--hard` ولا force-push إطلاقًا.
- **لا تضع في هذا الدليل ولا تنفّذ أي أمر يحذف مجلدات أو قواعد بيانات.**

## محظورات هذا الدليل

- لا بيانات دخول ولا قيم سرية في أي أمر أو مثال.
- لا مسارات شخصية مطلقة — استخدم `<PROJECT_ROOT>` ومسارات نسبية فقط.

## P5-SAFE-OPS — إجراءات آمنة (مضافة 2026-09-24 بعد حادثتين مُقاسَتين)

### أ) الكتابة في قاعدة التشغيل (إلزامي)
1. `npm run db:backup` — يكتب `.radar-data/backups/radar-backup-<UTC>.sqlite`، لا يستبدل نسخة موجودة.
2. **معاينة أولًا** (بلا كتابة) ثم تنفيذ بعلم صريح:
   ```bash
   node scripts/apply-agent-crew.mjs --db-root "D:/joUTricks/_Youtube/Radar/_E3tmaad/radar"            # معاينة
   node scripts/apply-agent-crew.mjs --db-root "..." --apply                                        # تنفيذ
   ```
3. **لا تعتمد على المسار الضمني (`.`)**: سكربت قديم استخدم `path.resolve(".")` فكتب في قاعدة أخرى
   بصمت (حادثة P5-AGENTS: الوثائق قالت «UAT حي مؤكد» وقاعدة التشغيل أثبتت عدم التطبيق بـ`updated_at`).
   أي أداة كتابة جديدة يجب أن: تطلب `--db-root` صراحةً · ترفض هدفًا بلا `.radar-data` · تطبع المسار
   والعدّادات قبل الكتابة · ترفض قاعدة بلا بيانات تشغيل بلا علم صريح.

### ب) حذف مجلد/worktree — خطر الروابط (إلزامي)
⚠️ في الشجرة **22 رابط `node_modules`** (junction). الحذف الشامل (`rm -rf`/`rmtree`/`worktree remove`)
قد **يتبع الرابط** فيمسح `node_modules` الحقيقي (367 مدخلًا). الإجراء:
```bash
cmd /c rmdir "<مسار-الرابط>"     # يزيل الرابط فقط (بلا /S) — لا يلمس الهدف
git worktree remove <المسار>      # ثم إزالة الـworktree
ls radar/node_modules | wc -l      # التحقق: 367 مدخلًا (قبل/بعد كل دفعة)
```
**لا تُمَس**: فروع `kimi/*` غير المدمجة · `radar-backups/` · `radar-recovery-bundles/` · `.wrangler/` ·
قاعدة التشغيل ونسخها الاحتياطية. وقبل حذف أي worktree: تأكد أنها **مدمجة**
(`git merge-base --is-ancestor <head> HEAD`) وأن `git status --short` داخلها فارغ.

### ج) إنشاء worktree للعمل
```bash
git worktree add -b alt/<name> ../radar-alt-<name> <commit-أساس-كامل>
powershell -Command "New-Item -ItemType Junction -Path '<worktree>\node_modules' -Target '<repo>\node_modules'"
```
**فخ CWD**: المستودع الحقيقي هو `D:/joUTricks/_Youtube/Radar/_E3tmaad/radar` (لاحظ `_E3tmaad`) —
مسار ناقص يعطي نتائج فارغة زائفة. تحقق بـ`pwd` قبل كل بوابة، وقد تكون الجلسة ارتدّت للمستودع الرئيسي.

### د) قواعد المراجعة المستقلة
- المراجع لا يفتح قاعدة التشغيل إطلاقًا: `RADAR_DB_ROOT=<مؤقت خارج المستودع>` + `RADAR_SYNC_PORT=0`.
- لا merge/push/rebase/reset، ولا تعديل ملفات، ولا تشغيل حي (اعتماد/Chrome/Ollama/n8n/تنزيل).
- **المنفّذ لا يدمج عمله**: مراجعة مستقلة ثم قرار المالك، ثم `git merge --ff-only` بمهمة منفصلة.

### D. الرفع إلى GitHub (إن أُذن صريحًا)
1. `gh auth status` (المتوقع: حساب المالك، صلاحية `repo`).
2. **فحص ما قبل النشر (إلزامي)**: لا ملف `.sqlite`/`.radar-data`/مرفق/`.env`/مفتاح — في الشجرة **وفي التاريخ كاملًا**
   (`git rev-list --objects --all` + مسح أنماط الأسرار). وإن وُجد مرفق اعتماد أو قاعدة: **توقف** وأبلغ المالك.
3. أنشئ/استخدم مستودعًا **خاصًّا** وادفع **`main` فقط**: `git push -u origin main` (لا `--all` ولا `--mirror`).
4. **تحقق من النتيجة بالقراءة من GitHub**: `git ls-remote --heads origin` (فرع واحد) +
   `gh api repos/<owner>/<repo>/git/trees/main?recursive=1` (لا ملفات بيانات).
5. لا تدفع أي فرع مؤقت (`alt/*`, `kimi/*`) بلا أمر صريح — فروع العمل تبقى محلية.
