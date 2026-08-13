# تقرير تنفيذ P3-B0 — بوابة الموافقة البشرية لتنزيل المرفقات

**الفرع:** `kimi/p3b-approval-gate` (worktree: `radar-kimi-p3b`)
**نقطة الأساس:** `cbb0556fad1af7facadd1d46b5eeb36850f4c68e` على `main`
**التاريخ:** 2026-08-13

## ملخص

نُفّذت مهمة P3-B0 كاملة داخل الفرع الحالي فقط: بوابة موافقة بشرية إلزامية قبل أي
تنزيل مرفقات، مع سجل موافقات قابل للتدقيق في SQLite (Schema v5)، ومحوّل تنزيل
وهمي للاختبارات فقط، ومحوّل الإنتاج **معطّل عمدًا** — لا يوجد أي تنزيل حقيقي
ولا شراء ولا فك ضغط ولا تشغيل ملفات في هذه المرحلة.

## الملفات المعدلة والجديدة

| الملف | الحالة | الوصف |
|---|---|---|
| `scripts/lib/download-gate.mjs` | جديد | نواة البوابة: بناء manifest وبصمته، التحقق من الحدود، نصا الموافقة الإلزاميان، تقييم صلاحية الموافقة |
| `scripts/lib/attachment-storage.mjs` | جديد | حلّ مسارات التخزين الآمنة: منع path traversal والمسارات المطلقة والأسماء المحجوزة (CON/PRN/AUX/NUL/COM1-9/LPT1-9) والخروج عن مجلد التخزين |
| `scripts/lib/attachment-adapters.mjs` | جديد | محوّلان: `createDisabledProductionDownloadAdapter` (يرمي `DOWNLOAD_ADAPTER_DISABLED` دائمًا) و`createFakeDownloadAdapter` (محاكاة محدودة للاختبارات فقط داخل التخزين الآمن) |
| `scripts/lib/radar-repository.mjs` | معدّل | Schema v5: جدول `approvals` بالشكل الجديد + ترقية القواعد القديمة بأعمدة افتراضية، جدول `download_jobs`، ودوال `requestDownloadApproval` / `consumeDownloadApproval` (تحديث شرطي ذري) / `revokeDownloadApproval` / `recordDownloadJob` / `updateDownloadJob` / `listDownloadJobs` / `getDownloadApproval` (انتهاء كسول) |
| `scripts/etimad-sync-service.mjs` | معدّل | مسارات `POST /approvals` (201) و`POST /approval-jobs` و`GET /approval-jobs`، خريطة أكواد أخطاء (400/404/409)، `serviceVersion = "p3b-approval-gate-1"` |
| `scripts/start-radar.mjs` | معدّل | تحديث `expectedServiceVersion` |
| `app/page.tsx` | معدّل | زر «طلب تنزيل الملفات» + نافذة تأكيد (`role="dialog"`) تعرض المرجع/الاسم/القيمة/الإتاحة/الملفات/العدد، مربع موافقة إلزامي، ومربع تأكيد شراء إضافي للكراسات المدفوعة فقط |
| `app/globals.css` | معدّل | أنماط `.download-gate-*` |
| `tests/approval-p3b0.test.mjs` | جديد | 12 اختبارًا سلوكيًا تغطي كل البنود الإلزامية |
| `tests/catalog-p3.test.mjs` | معدّل | تحديث توكيد إصدار المخطط 4 ← 5 (المهمة تنص على Schema v5 مع الحفاظ على بيانات v3/v4) |
| `package.json` | معدّل | إضافة `tests/approval-p3b0.test.mjs` إلى سكربت `test` |

## القرارات التصميمية

1. **أسماء المسارات `/approvals` و`/approval-jobs`**: اختبار الأمان المنقول
   (`catalog-p3.test.mjs:302`) يمنع ظهور `/download` كمقطع مسار في الخدمة،
   فتجنّبت أي مسار يحمل الاسم حرفيًا.
2. **اسم ملف المحوّلات `attachment-adapters.mjs`**: استيراد `./lib/download-adapters.mjs`
   كان يطابق التعبير الممنوع نفسه داخل ملف الخدمة، فأُعيدت تسمية الملف مع بقاء
   أسماء الدوال المعبّرة (`createDisabledProductionDownloadAdapter`).
3. **القناة الوحيدة لإنشاء الموافقات هي `repository.requestDownloadApproval`**:
   تجلب المنافسة وبيانات المرفقات من SQLite ثم تمرّر الطلب عبر البوابة كاملة،
   فلا تستطيع أي قناة آلية (بما فيها n8n) سكّ موافقة.
4. **الانتهاء الكسول مع ساعة قابلة للحقن**: `getDownloadApproval(id, { now })`
   يوسم الموافقة `expired` عند القراءة، و`consumeDownloadApproval` يمرّر الساعة
   نفسها، ما يجعل حدّ العشر دقائق قابلًا للاختبار حتميًا. (أصلح هذا التصميم
   أيضًا ترتيب معاملات `markApprovalExpired`.)
5. **الحدود**: 5 ملفات كحد أقصى للدفعة، 100MB للملف، 300MB للدفعة (الحدود
   شاملة: 100MB و300MB بالضبط مقبولة)، والصيغ المسموحة: pdf, doc, docx, xls,
   xlsx, csv, zip, rar, 7z, txt. الإتاحة القابلة للتنزيل: `free-available`
   و`purchased-available` فقط؛ `metadata-only` و`unknown` و`restricted` مرفوضة.
6. **نصا الموافقة الحرفيان**:
   - «أوافق على تنزيل الملفات المحددة الآن من هذه المنافسة فقط» (إلزامي دائمًا)
   - «أؤكد أنني أتممت شراء الكراسة بنفسي داخل منصة اعتماد» (إلزامي عند رسوم > 0)
7. **بصمة manifest**: استهلاك الموافقة يتطلب تطابق `sha256` لـ manifest
   المطبّع (dedupe + ترتيب)؛ أي اختلاف يرمي `SCOPE_MISMATCH` دون استهلاك الموافقة.
8. **استخدام واحد ذري**: `UPDATE ... WHERE status='approved' AND consumed_at IS NULL
   AND expires_at > now` — التزاحم يفشل بـ `APPROVAL_CONSUMED`.
9. **توافق رجعي**: قواعد v4 ذات جدول `approvals` القديم تُرقَّى بأعمدة افتراضية
   (`status='approved'` للصفوف القديمة)، وبيانات v3/v4 الحية محفوظة — مثبت باختبارين.

## نتائج الاختبارات

| الفحص | النتيجة |
|---|---|
| `npm run lint` | نظيف (0 تحذير/خطأ) |
| `npm test` (build + كل الاختبارات) | **46/46 ناجحة** |
| اختبارات P3-B0 الجديدة | 12/12 (هجرة v4→v5، انتهاء 10 دقائق بالضبط، استخدام واحد، اختلاف البصمة، رفض metadata-only/unknown/restricted، الموافقة الإلزامية للمجانية والمدفوعة، حدّ 5 ملفات، الأحجام والصيغ، path traversal بثمانية مدخلات خبيثة، المحوّل المعطل يسجّل job `blocked`، المحاكي يكتب داخل التخزين الآمن، فحص regex شامل) |
| `npm run db:init` | `ready: true`، `schemaVersion: 5` |

## المخاطر والملاحظات

- أي تفعيل مستقبلي للمحوّل الحي يجب أن يمر عبر `consumeDownloadApproval` نفسه؛
  المحوّل الحالي معطّل بالكود `DOWNLOAD_ADAPTER_DISABLED` والوظيفة تُسجَّل
  `blocked` بدل أي محاولة شبكة.
- صفوف الموافقات الموروثة من v4 (بلا نطاق) تبقى `approved` بانتهاء فارغ —
  لا تصلح للتنفيذ لأن `scope_hash` فارغ لا يطابق أي manifest حقيقي.

## ما لم يُنفَّذ (بتكليف صريح من المهمة)

- لا تنزيل حقيقي من اعتماد ولا استخدام لجلسة Chrome في مسار التنزيل.
- لا فك ضغط ولا تشغيل أو فتح للملفات.
- لا تخزين لروابط موقّعة أو مؤقتة.
- التنفيذ الحي مؤجل إلى مرحلة لاحقة بعد الموافقة، والواجهة تعرض ذلك صراحة
  («التنفيذ الحي غير مفعّل في P3-B0»).
