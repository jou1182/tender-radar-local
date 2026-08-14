# منصة المقارنة Offline المحايدة بين النماذج — P4‑M0A

منصة محلية حتمية لمقارنة مخرجات أي نموذجين لاحقًا، دون استدعاء أي نموذج أو خدمة
في هذه المرحلة. كل المدخلات اصطناعية، وكل المخرجات قابلة لإعادة الإنتاج
بـSHA‑256.

## المكوّنات

| المسار | الدور |
|---|---|
| `manifest.json` | الحالات الثلاث وبصمات fixtures (مولَّد، يطابق `benchmark-manifest.schema.json`) |
| `benchmark-manifest.schema.json` | JSON Schema المحلي للـmanifest — `additionalProperties: false` |
| `cases/<caseId>/fixture-spec.json` | مواصفة مؤلفة يدويًا: صفحات PDF والتوقعات والممنوعات |
| `cases/<caseId>/fixture.pdf` | وثيقة PDF اصطناعية حتمية (كل صفحة تحمل علامة «بيانات اختبار اصطناعية — ليست منافسة حقيقية») |
| `cases/<caseId>/ground-truth.json` | الإجابة المرجعية: `candidateIds` محلولة من كتالوج النظام الفعلي فقط |
| `samples/*.json` | تقارير نموذجية ثابتة للاختبارات فقط |
| `runtime-freeze.json` | بصمات ملفات runtime التحليلية عند الأساس — حارس عدم تغيير سلوك المحرك |
| `scripts/generate-analysis-benchmark-fixtures.mjs` | التوليد الحتمي + التحقق الذاتي |
| `scripts/run-analysis-benchmark.mjs` | تشغيل تقييم Offline لتقرير محلي جاهز |
| `scripts/lib/analysis-benchmark-manifest.mjs` | تحميل الحالات والتحقق من manifest وground-truth |
| `scripts/lib/analysis-benchmark-evaluator.mjs` | المُقيّم المحايد |

## الحالات الثلاث

1. **m0a-clear** (`TEST-M0A-001`): وثيقة واضحة تغطي الفئات الاثنتي عشرة كلها
   بمعلومات صريحة، مع بند واحد غير واضح وسؤال واحد للجهة.
2. **m0a-tables** (`TEST-M0A-002`): ثلاث صفحات بجدول كميات (حفر/خرسانة/أسفلت)
   وضمانات وغرامات موزعة بين الصفحات؛ تختبر حفظ رقم الصفحة في الكتالوج.
3. **m0a-ambiguous** (`TEST-M0A-003`): تعارضات ونواقص مقصودة (مدتا تنفيذ، ضمان
   غير محدد، كمية فارغة، شرط سداد ناقص). الإجابة المرجعية تسجل التعارض في
   `unclearItems` و`questionsForAuthority` وتمنع أي قيمة تعسفية.

## قواعد المُقيّم

### بوابات الأمان الصلبة (تُحسم قبل أي درجة)

| البوابة | الفشل يعني |
|---|---|
| `inputModelIdNeutral` / `inputTelemetryContract` | INVALID_BENCHMARK_INPUT |
| `inputFixtureHashMatchesManifest` (SHA‑256) | INVALID_BENCHMARK_INPUT |
| `inputCatalogMatchesFixture` / `inputGroundTruthValid` | INVALID_BENCHMARK_INPUT |
| `reportSchemaValid` (analysis-report-v2) | SAFE_REJECTION |
| `reportNoExtraFields` | SAFE_REJECTION |
| `reportNoUnknownCandidateIds` | SAFE_REJECTION |
| `reportGroundingLiteral` (قواعد grounding الإنتاجية كما هي) | SAFE_REJECTION |
| `reportFindingsSupported` | SAFE_REJECTION |
| `reportNoForbiddenAssertions` (القيم التعسفية/الممنوعة) | SAFETY_FAILURE |
| `reportStatementsGroundedInEvidence` (finding مختلق) | SAFETY_FAILURE |

- **SAFE_REJECTION**: رفض آمن كان نظام الإنتاج سينفذه قبل حفظ التقرير.
- **SAFETY_FAILURE**: مخرج غير آمن كان سيُقبل لولا المُقيّم.
- **INVALID_BENCHMARK_INPUT**: خطأ في fixture أو manifest أو مدخلات المنصة نفسها.
- أي finding مختلق أو غير مسند يفشل بوابة أمان؛ ليس مجرد خصم درجات.

### توزيع درجات الجودة (بعد PASS فقط) — المجموع 100

| البند | الوزن |
|---|---|
| تغطية الحقائق المتوقعة | 35 |
| صحة التصنيف ضمن الفئات | 15 |
| صحة اختيار الأدلة | 25 |
| معالجة الغموض والتعارض والنواقص | 15 |
| اكتمال البنود الإلزامية | 10 |

## حياد المنصة

- `modelId` سلسلة محايدة (`model-a`, `model-b`, …) لا تدخل في الدرجة ولا يوجد
  عليها أي شرط، ولا يوجد نموذج افتراضي، ولا أي افتراض عن حجم نموذج أو منتجه.
- ترتيب التنفيذ لا يرجّح أي نموذج: كل تقييم استدعاء مستقل بلا حالة.

## عقد telemetry (للمراحل اللاحقة)

مفاتيح معروفة اختيارية: `totalDurationNs`, `loadDurationNs`, `promptEvalCount`,
`promptEvalDurationNs`, `evalCount`, `evalDurationNs`, `tokensPerSecond`,
`peakMemoryBytes` (أعداد) و`timeout` (منطقية). في P4‑M0A تُمرَّر قيم مصطنعة في
الاختبارات فقط، وتُعاد كما وردت دون اختلاق، ولا تدخل في `qualityScore`.

## الأوامر

```bash
npm run benchmark:fixtures   # إعادة توليد benchmark/ حتميًا + تحقق ذاتي
npm run benchmark:run -- --case m0a-clear --report benchmark/samples/valid-report.json --model model-a
```

## ملاحظة تجميد runtime

`runtime-freeze.json` يحمل بصمات ملفات `scripts/lib/analysis-*.mjs` عند commit
الأساس. أي تعديل مستقبلي مشروع على محرك التحليل يستلزم تحديث هذا الملف ضمن
مهمته الخاصة المعتمدة، مع بقاء الاختبارات السابقة ناجحة.
