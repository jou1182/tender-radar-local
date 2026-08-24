# KIMI P4-A0 Report — البنية المحلية لتحليل وثائق المنافسات

## 1. التحقق من الفرع والقاعدة

- ساحة العمل: `C:\Users\AMANA\Desktop\اعتماد\radar-kimi-p4a` (worktree مستقل)
- الفرع: `kimi/p4a-local-analysis`
- قاعدة البدء: `88c021effc314c205e74d93e11811e4e4b26d934` — أحدث commit معتمد على `main` وقت البدء
- المشروع الرئيسي `C:\Users\AMANA\Desktop\اعتماد\radar`: قراءة فقط، لم يُعدَّل أي ملف فيه
- لا يوجد `KIMI_TASK.md` داخل الـcommit، ولا أسرار ولا ملفات تشغيلية

## 2. ملخص المعمارية

```
analysis-fixtures/            ← ملفات مصطنعة مغلقة القائمة (PDF/XLSX/DOCX) + README
scripts/lib/analysis-fixtures.mjs    ← سجل fixtureId المغلق (لا مسارات من العميل)
scripts/lib/analysis-documents.mjs   ← أمان المسارات + فحص الامتداد/التوقيع/الحجم + مستخرجات نصية
scripts/lib/analysis-chunking.mjs    ← تقسيم حتمي bounded مع overlap ومعرفات ثابتة ومصادر محفوظة
scripts/lib/analysis-report.mjs      ← صيغة التقرير المنظمة + التحقق + قاعدة «لا قرار بلا أدلة»
scripts/lib/analysis-providers.mjs   ← StubProvider (افتراضي) + OllamaProvider (loopback صريح فقط)
scripts/lib/analysis-engine.mjs      ← تنسيق المهمة: إنشاء ← تشغيل ← حفظ، مع سجل تشغيل بلا نصوص
scripts/lib/analysis-api.mjs         ← موجه /analysis/* برسائل عربية وأكواد أخطاء مستقرة
scripts/etimad-sync-service.mjs      ← توصيل الموجه بعد مسار /sync (معزول تمامًا)
workflows/p4a-local-analysis.json    ← workflow n8n غير مفعّل + README بتوثيق الاستيراد لاحقًا
app/page.tsx + app/globals.css       ← شريط حالة صغير لمحرك التحليل (قراءة حالة فقط)
```

## 3. الملفات

**مضافة:** `analysis-fixtures/` (3 ملفات + README)، `scripts/lib/analysis-{fixtures,documents,chunking,report,providers,engine,api}.mjs`، `tests/analysis-p4a.test.mjs`، `tests/helpers/analysis-fixture-factory.mjs`، `workflows/p4a-local-analysis.json`، `workflows/README.md`، هذا التقرير.

**معدّلة:** `scripts/lib/radar-repository.mjs` (Schema v7 + دوال التحليل)، `scripts/etimad-sync-service.mjs` (توجيه /analysis/* + الإصدار p4a-local-analysis-1)، `scripts/initialize-database.mjs` (دعم `RADAR_DB_INIT_ROOT` لقاعدة مؤقتة)، `app/page.tsx` و`app/globals.css` (مؤشر الحالة)، `package.json` (إضافة الاختبار)، `tests/{catalog-p3,approval-p3b0,live-acquisition-p3b1}.test.mjs` (توقع الإصدار 7 واسم نسخة الخدمة فقط).

## 4. الجداول والـmigration (Schema v7)

`migrationVersion = 7`، وكل الجداول الجديدة `CREATE TABLE IF NOT EXISTS` — الترحيل idempotent ولا يفقد بيانات:

- `analysis_documents` — id، tender_reference، document_type (pdf/xlsx/docx)، original_file_name، local_stored_name، checksum (SHA-256)، mime_type، size_bytes، source_kind='fixture'، fixture_id، registered_at
- `analysis_jobs` — id، tender_reference، document_id، job_status (queued/extracting/analyzing/completed/failed/cancelled)، provider، model، prompt_version، output_schema_version، report_json (التقرير المنظم المصدَّق فقط)، timestamps، error_code/error_message
- `analysis_findings` — category/statement/severity/confidence/evidence_ids_json
- `analysis_evidence` — evidence_id، document_id، source_type، page_number/sheet_name/cell_range/section، excerpt (≤400 حرف)، chunk_id
- `model_runs` — provider/model/status/duration_ms/prompt_version/output_schema_version/error_code فقط — **بلا أي نص طلب أو استجابة**

**أرقام الترحيل (fixture):** قاعدة v6 خام بصفّي tenders وصف approvals واحد → قبل: 2/1، بعد: 2/1، وكل الأدلة (`detail-verified`، `card-observed`) محفوظة، وإعادة الفتح لا تغيّر شيئًا.

## 5. طبقة المستندات

- الأنواع: PDF (صفحات مرقمة، نص Tj/TJ بترميز UTF-16BE، فك Flate)، XLSX (أوراق مسماة، خلايا بعناوين، سلاسل مشتركة، جداول)، DOCX (عناوين Heading1 كأقسام، فقرات، جداول).
- قارئ ZIP أدنى داخلي (Stored/Deflate عبر zlib) — بلا اعتماديات جديدة وبلا أي تنفيذ لمحتوى مضمن أو macros أو روابط.
- الفحوص: امتداد ضمن القائمة فقط، توقيع داخلي مطابق (%PDF- / PK\x03\x04 + بنية النوع)، حد الحجم `RADAR_ANALYSIS_MAX_FILE_MB` (افتراضي 30)، رفض المسارات المطلقة وpath traversal والخروج عن جذر fixtures.
- التمثيل الموحد: `blocks` بنوع (heading/paragraph/table-row/page-text) ونص ومصدر (pageNumber / sheetName+cellRange / section) + `tables` + `warnings` + checksum.

## 6. التقسيم

حتمي بالكامل: نفس المستند → نفس الأجزاء ونفس `chunkId` (مشتق بـSHA-256 من معرف المستند والترتيب والكتل). حد أقصى 1200 حرف، overlap ‏120 حرفًا بكتل كاملة، العناوين تلتصق بمحتواها، وصفوف الجدول الواحد لا تُفصل، ومصدر كل جزء محفوظ كدليل.

## 7. المزودان

- **StubProvider (الافتراضي):** تحليل قواعد حتمي فوق النص المستخرج — بلا أي اتصال. يستخرج الضمانات والغرامات والمواعيد والأهلية والخبرة ونطاق العمل وجداول الكميات والبنود غير الواضحة والأسئلة، ويربط كل finding بأدلة (chunkId + موضع).
- **OllamaProvider:** لا يعمل إلا بـ`RADAR_AI_ENABLED=true` صريح؛ مضيف loopback حصرًا (`http://127.0.0.1` أو `localhost` أو `[::1]` — أي مضيف آخر مرفوض بـ`AI_UNTRUSTED_HOST` حتى مع https لغير المسار المحلي)؛ مهلة واضحة (60s افتراضيًا عبر `AbortSignal.timeout`)؛ محاولة واحدة بلا إعادة؛ **لا سحب نماذج إطلاقًا** (نقطة التوليد فقط، ومثبت اختباريًا)؛ يرسل الأجزاء النصية الضرورية فقط (بحد 6000 حرف) ولا يرسل ملفات كاملة؛ الفشل بأمان بأكواد `AI_PROVIDER_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_OUTPUT_INVALID`؛ يسجل النموذج والمدة والحالة فقط.

## 8. صيغة تقرير التحليل

كل الحقول الـ17 المطلوبة (`executiveSummary` … `evidence`) + `preliminaryDecision ∈ {enter, review, exclude, insufficient_data}`. كل finding: category/statement/severity/confidence/evidenceIds (غير فارغة وتشير لأدلة موجودة). كل evidence: evidenceId/documentId/sourceType/(pageNumber | sheetName+cellRange | section)/excerpt قصير/chunkId. **القاعدة الصارمة:** تقرير بلا evidence لا يجوز أن يحمل قرارًا غير `insufficient_data` — مرفوض بالتحقق.

## 9. API المحلية

- `GET /analysis/health` → provider، aiEnabled، model، status (stub/disabled/ollama-local)، إصدارات الصيغة، قائمة fixtures.
- `POST /analysis/jobs` ← `{fixtureId}` فقط؛ أي path/file/content من العميل → `ANALYSIS_PATH_NOT_ALLOWED` (400)؛ fixture مجهول → 404.
- `GET /analysis/jobs/:id` → المهمة + الوثيقة + النتائج + سجل التشغيل.
- `POST /analysis/jobs/:id/run` → تشغيل؛ queued فقط (غير ذلك 409)؛ أخطاء AI بـ503/502، وأخطاء المستندات بـ422، وكلها رسائل عربية.
- لم تُمس مسارات المزامنة أو الموافقات أو التنزيل — مثبت اختباريًا بتقسيم نص الخدمة.

## 10. workflow n8n

`workflows/p4a-local-analysis.json` — غير مفعّل (`active: false`)، 6 عقد قياسية فقط (webhook → تحقق مدخل → HTTP POST إلى `127.0.0.1:4318/analysis/jobs/{id}/run` → تسجيل نجاح/فشل). بلا credentials ولا أسرار ولا عقد AI سحابية ولا ملفات ولا اعتماد. طريقة الاستيراد موثقة في `workflows/README.md` — **لم يُستورد ولم يُشغَّل**.

## 11. الواجهة

شريط حالة صغير تحت مركز الأتمتة يعرض: **معطل / Stub للاختبار / Ollama محلي / غير متصل** (من `GET /analysis/health`)، مع توضيح «fixtures اختبارية فقط». لا يوجد أي زر يحلل مستندًا حقيقيًا، ولم تتغير أزرار المزامنة أو المرفقات أو التنزيل.

## 12. نتائج التحقق

- `npm test` (يشمل `npm run build`): **91 ناجحًا / 0 فاشل** — كل اختبارات P0–P3-B1B0 + 15 اختبار P4-A0 تغطي البنود العشرين.
- `npm run lint`: **نظيف** (0 مشاكل).
- `npm run db:init` على قاعدة مؤقتة (`RADAR_DB_INIT_ROOT`): `"ready": true`، **`"schemaVersion": 7`** — لم تُلمس قاعدة المشروع.
- `git diff --check`: نظيف. `git status --short`: ملفات المهمة فقط.
- فحص Ollama الاختياري (`GET http://127.0.0.1:11434/api/tags` فقط): **الخدمة تعمل محليًا**، لكن النموذج المهيأ `qwen2.5:7b` **غير مثبت** — المتوفر الوحيد `qwen2.5:14b`. لم يُسحب أي نموذج ولم تتغير الإعدادات؛ عند تفعيل Ollama مستقبلًا يجب ضبط `OLLAMA_MODEL` يدويًا أو تثبيت النموذج بقرار بشري.

## 13. تغطية البنود العشرين

1. ترحيل v6→v7 بلا فقد ✔ · 2. إعادة الترحيل idempotent ✔ · 3. العربية UTF-8 محفوظة في الأنواع الثلاثة ✔ · 4. استخراج fixture لكل نوع مع مواضع ✔ · 5. رفض نوع غير مدعوم ✔ · 6. رفض MIME مخالف للامتداد ✔ · 7. رفض تجاوز الحجم ✔ · 8. منع traversal والمطلق ومسارات العميل ✔ · 9. تقسيم حتمي ثابت المعرفات مع overlap ✔ · 10. حفظ أدلة الصفحات/الأوراق/الخلايا/الأقسام ✔ · 11. تحليل end-to-end بنجاح عبر Stub مع تقرير موثق بالأدلة ✔ · 12. فشل Ollama بأمان عند التعطيل ✔ · 13. رفض المضيف الخارجي ✔ · 14. لا model pull (مثبت بسجل النداءات المزيفة) ✔ · 15. رفض مخرجات غير مطابقة للصيغة ✔ · 16. لا قرار بلا evidence ✔ · 17. عزل fixtures عن بيانات الإنتاج وقاعدة اختبار مؤقتة ✔ · 18. صلاحية workflow n8n وخلوه من الأسرار والنطاقات الخارجية ✔ · 19. بقاء P3-B1B/C والتنزيل الحي متوقفة ومعطلة ✔ · 20. خلو وحدات التحليل من Chrome/اعتماد/المزامنة ✔

## 14. المخاطر والقيود

- المستخرجات مبنية للملفات المنظمة البسيطة؛ المستندات الحقيقية المعقدة (خطوط مضمنة، نصوص ممسوحة، جداول مدمجة) ستحتاج مكتبات متخصصة في مرحلة لاحقة — والبنية تحتمل ذلك خلف نفس الواجهة.
- StubProvider قواعده عربية بسيطة؛ دقته محدودة بالتصميم وهو للاختبار فقط.
- OllamaProvider لم يُجرَّب حيًا في هذه المهمة (النموذج المهيأ غير مثبت)؛ مجرى النداء والتحقق مثبتان بمحاكاة كاملة.
- حالات `cancelled` مدعومة في المخطط ولا توجد لها عملية إلغاء بعد (مقصود في P4-A0).

## 15. خطوات مقترحة لـP4-A1

1. تفعيل Ollama يدويًا بعد تثبيت/ضبط النموذج، مع اختبار تعاقدي حي محدود على fixture واحد.
2. ربط المستندات الحقيقية المخزنة من مركز المرفقات (بعد موافقات P3 القائمة) بدل fixtures فقط.
3. واجهة قراءة تقرير التحليل داخل صفحة المنافسة (عرض فقط).
4. استيراد workflow n8n محليًا وتجربته على مهمة fixture.
5. تقييم مكتبة استخراج متخصصة للمستندات الحقيقية المعقدة.

## 16. تأكيدات صريحة

- **لا اتصال خارجي إطلاقًا:** الشبكة الوحيدة في الاختبارات fetch مزيف؛ الفحص الاختياري الوحيد كان `127.0.0.1:11434/api/tags` (مسموح صراحة).
- **لم يُشغَّل Chrome ولا اعتماد ولا مزامنة** في أي خطوة.
- **لم يُنزَّل أو يُشترَ أو يُصدَّر أي ملف**؛ fixtures مصطنعة محليًا بالكامل.
- **لم تُلمس قاعدة SQLite الإنتاجية** ولا المشروع الرئيسي `radar`.
- **لم يُستورد workflow في n8n** ولم يُشغَّل n8n.
- **خصائص الذكاء الاصطناعي معطلة افتراضيًا** (`RADAR_AI_ENABLED=false`، `RADAR_AI_PROVIDER=stub`).
- **لا merge ولا rebase ولا push**؛ commit واحد فقط على الفرع.
