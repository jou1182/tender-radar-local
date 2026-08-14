# تقرير P4-A0R2 — جولة التصحيح الثانية لأساس التحليل المحلي

**الفرع:** `kimi/p4a-local-analysis` (worktree `radar-kimi-p4a`)
**الأساس:** commit P4-A0R `cdb04ce7853c83e54d3d30486234942eb2c6f9dd`
**النطاق:** التصحيحات الثمانية المطلوبة فقط — بلا دمج، بلا rebase، بلا push، بلا أي تشغيل حي.

## ما نُفذ

1. **إصدارات v2:** `analysisReportSchemaVersion = "analysis-report-v2"` و`analysisPromptVersion = "p4a-prompt-v2"` في `analysis-report.mjs`، وتنعكس تلقائيًا في المحرك والمزود والـAPI والسجلات.
2. **12 فئة findings موثقة:** أُضيفت `scopeOfWork` و`boqSummary` و`criticalQuantities` إلى `analysisFindingFields`؛ أُزيلت فئة «النصوص الحرة» من المدقق، ولم يبقَ بلا دليل سوى `executiveSummary` و`warnings`. الـstub ينتج findings بأدلة للنطاق والبواق والكميات (دليل الجدول من كتلة فعلية داخل الجزء)، وحلقة الحفظ في المستودع تخزن الفئات الاثنتي عشرة كلها.
3. **طلب Ollama المحسّن:** الـprompt يطلب `decisionEvidenceIds` صراحة، ويشرح الشكل الكامل لكل finding (category/statement/severity/confidence/evidenceIds) وكل evidence (مع الموقع حسب النوع)، ويطلب نسخ `excerpt` حرفيًا من نص الجزء، ويرسل مع كل chunk ترويسة مصدر `[chk-…] sourceType=… ; pageNumber=… / sheetName+cellRange / section=…`، ويفعّل `format: "json"` في جسم الطلب. اختبار S3 يفحص **جسم الطلب نفسه** (format وstream والتعليمات وترويسات المصادر) لا مجرد الاستجابة.
4. **إنشاء المزود داخل try بعد الحجز:** فشل الإعداد (مضيف غير موثوق) يحول المهمة إلى `failed` بـ`errorCode` و`finishedAt` وسجل model_run فاشل — لا تبقى `extracting` ولا يحدث أي اتصال (S2 يؤكد صفر استدعاءات fetch).
5. **فحص `/api/tags` فعلي:** يقرأ `models[].name` أو `models[].model`؛ `available` فقط إذا كان `OLLAMA_MODEL` المحدد مثبتًا؛ الخدمة تعمل والنموذج غائب → `model-unavailable`؛ لا pull ولا أي تغيير تلقائي. الواجهة تعرض «النموذج غير مثبت محليًا» (S4 + تحديث R10).
6. **نزاهة الأدلة المشددة:** `normalizeReportEvidenceIds` يرفض `evidenceId` المكرر داخل التقرير قبل التطبيع (`ANALYSIS_OUTPUT_INVALID`)؛ `verifyReportGrounding` يفرض تطابق `sourceType` مع نوع المستند، ومتطلبات الموقع حسب النوع (PDF: `pageNumber` صحيح؛ XLSX: `sheetName`+`cellRange` معًا؛ DOCX: `section`)، مع بقاء إلزام تطابق chunkId والموقع والمقتطف الحرفي (S5, S6, S7).
7. **تشديد ZIP/PDF الإضافي:** الحجم الفعلي بعد الفك يجب أن يساوي `uncompressedSize` المعلن (`DOCUMENT_CORRUPT` للأحجام الكاذبة)؛ الحد الإجمالي يُحسب بالأحجام الفعلية؛ أسماء الأعضاء المكررة مرفوضة؛ تدفقات PDF المضغوطة محدودة بـ`maxOutputLength` (افتراضي 8 م.ب، قابل للضبط عبر `maxStreamBytes`) (S8, S9).
8. **schemaVersion بقي 7** — لا هجرة جديدة لأن P4-A لم تُدمج بعد؛ التغيير مقتصر على إصداري التقرير والـprompt.

## نتائج التحقق

- `node --test` لملفات التحليل الثلاثة → **35/35 ناجح** (9 اختبارات S جديدة).
- `npm test` (يشمل `npm run build`) → **111/111 ناجح** (كل اختبارات P0 حتى P4-A0R2).
- `npm run lint` → **نظيف**.
- `git diff --check` → نظيف؛ ملفات fixtures الثنائية لم تُمس.

## تأكيدات النطاق

- لا تعديل على `main` ولا merge ولا rebase ولا push — commit تصحيحي واحد فوق `cdb04ce`.
- لا Chrome، لا اعتماد، لا مزامنة، لا تنزيل، لا استهلاك موافقة، لا Ollama أو n8n حي، ولا اتصال خارجي — كل الاختبارات fixtures وfetch مزيف فقط.
- محوّل التنزيل الحي بقي معطلًا افتراضيًا وحواجز P3 كلها قائمة.
