# تقرير P4-A0R — جولة تصحيح أساس التحليل المحلي

**الفرع:** `kimi/p4a-local-analysis` (worktree `radar-kimi-p4a`)
**الأساس:** commit P4-A0 `582e395d7c2448203fb6c0caa4847b07f8f62498`
**النطاق:** تصحيحات البنود العشرة فقط — بلا دمج، بلا rebase، بلا أي تشغيل حي.

## ما نُفذ (البنود العشرة)

1. **توحيد نسخة الخدمة:** `scripts/start-radar.mjs` كانت تتوقع `p3b1b0-fee-integrity-1`؛ وُحدت إلى `p4a-local-analysis-1` المطابقة لـ`serviceVersion` في الخدمة، مع اختبار يقارن السلسلتين نصيًا (R1).
2. **تطبيع معرفات الأدلة:** `normalizeReportEvidenceIds(report, job.id)` تعيد ترقيم كل دليل إلى `ev-<نطاق المهمة>-<n>` قبل الحفظ، وتعيد كتابة `findings.evidenceIds` و`decisionEvidenceIds`؛ المراجع غير المعروفة تُترك ظاهرة ليسقطها المدقق. زال تصادم المفتاح الأساسي في `analysis_evidence` بين المهمات (R2).
3. **استيلاء ذري:** `claimAnalysisJob` (`UPDATE ... WHERE id=? AND job_status='queued'`) في المستودع؛ `runJob` لا ينشئ المزود ولا يستدعيه إلا بعد `changes === 1`، والمتسابق الثاني يُرفض بـ`ANALYSIS_JOB_NOT_RUNNABLE` (409 عبر الـAPI). اختبار تنافس فعلي: المزود يُستدعى مرة واحدة فقط (R3).
4. **التأسيس (grounding) + decisionEvidenceIds:**
   - `verifyReportGrounding` ترفض (`ANALYSIS_GROUNDING_FAILED`) أي دليل: معرف مستنده لا يطابق مستند المهمة، أو جزءه غير موجود، أو موضعه (صفحة/ورقة+نطاق/قسم) خارج مصادر الجزء، أو مقتطفه ليس جزءًا حرفيًا من نص الجزء بعد تطبيع المسافات (R4).
   - فئات findings صارت تسعًا: eligibilityRequirements, requiredExperience, deadlines, bidBonds, guarantees, penalties, contractualRisks, unclearItems, questionsForAuthority — كلها كائنات موثقة بأدلة. النصية الحرة المتبقية: executiveSummary, scopeOfWork, boqSummary, criticalQuantities, warnings.
   - `decisionEvidenceIds` حقل مطلوب: غير فارغ ومراجعه موجودة عند enter/review/exclude، وفارغ مسموح مع insufficient_data (R5).
   - الـstub ينتج findings بأدلة لكل فئة، ودليل الجداول يقتبس من كتلة فعلية داخل الجزء (لا نص مُركّب).
5. **maxChars صارم في الـchunker:** لا تجميع كل صفوف الجدول في وحدة واحدة؛ كل صف عنصر مستقل مع إلصاق صف الترويسة كسياق عند الاستمرار (إن اتسع)؛ العنوان يلتصق بما يليه ضمن الحد؛ أي كتلة أطول من الحد تُقسم على حدود الكلمات إلى أجزاء ≤ maxChars بوسم `#p1/#p2…` ومصدر محفوظ. الضمان النهائي: كل `chunk.charCount ≤ maxChars` (R6، وتحديث تأكيدات اختبار 9-10 القديم).
6. **تحصين ZIP/PDF:** `readZipEntries` بحدود `maxEntries=64, maxMemberBytes=8MB, maxTotalBytes=16MB, maxRatio=100` مع تحقق أن الدليل المركزي والإزاحات المحلية وبيانات الأعضاء داخل المخزن الفعلي؛ رفض القنابل قبل فك الضغط، و`maxOutputLength` أثناءه. تدفقات PDF تُفك بـ`inflateSync` (zlib القياسي) مع fallback إلى Raw Deflate (R7, R8).
7. **حد جسم JSON:** وحدة جديدة `scripts/lib/http-body.mjs` (`readJsonBodyLimited`, حد 64 ك.ب، `REQUEST_BODY_TOO_LARGE`)؛ الخدمة تستوردها لكل النقاط، وخريطة الأخطاء تضيف 413 (R9).
8. **`.gitattributes` جذري:** `*.pdf/*.xlsx/*.docx binary` و`*.md text eol=lf`؛ ملف `analysis-fixtures/.gitattributes` حُصّر بالامتدادات الثنائية فقط بدل `* binary` لتجنب تعارض Markdown (R11).
9. **حالات Ollama الأربع:** `engine.health({probe})` صار async: stub / disabled / configured-unverified (بلا جسّ) / available|unavailable (بجسّ `/api/tags` بمهلة 1500ms عند الطلب فقط). الـAPI يستدعي `health({probe:true})`، والواجهة تعرض «Ollama محلي (غير مؤكد)» و«Ollama غير متاح» (R10).
10. **هذا التقرير** باسم `KIMI_P4A0R_REPORT.md`؛ تقرير P4-A0 السابق بقي كما هو.

## نتائج التحقق

- `node --test tests/analysis-p4a.test.mjs tests/analysis-p4a0r.test.mjs` → **26/26 ناجح** (11 اختبار R جديد + 15 محدثة/ثابتة).
- `npm run lint` → **نظيف** بلا تحذيرات.
- `npm test` (يشمل `npm run build`) → **102/102 ناجح** (كل اختبارات P0 حتى P4-A0R).
- `npm run db:init` → ناجح، `schemaVersion: 7`.
- `git diff --check` → نظيف؛ ملفات fixtures الثنائية لم تُمس.

## تأكيدات النطاق

- لا تعديل على `main` ولا merge ولا rebase ولا push — commit واحد فوق `582e395` فقط.
- لا Chrome، لا منصة اعتماد، لا مزامنة، لا تنزيل، لا استهلاك موافقة، لا Ollama أو n8n حي، لا اتصال خارجي، ولا مستندات حقيقية — كل الاختبارات fixtures ومحاكاة بـfetch مزيف.
- محوّل التنزيل الحي بقي معطلًا افتراضيًا، وحاجز الرسوم `FEE_NOT_DETAIL_VERIFIED` بقي مفروضًا (اختبار 19).
