# RECOVERY_BUNDLE — دليل حزمة التعافي المحايدة

> أُنشئت هذه الأدوات في مرحلة P4‑H1A. هي برمجية واختبارية فقط: لم تُصنع أي حزمة
> حقيقية من المشروع الرئيسي في تلك المرحلة، ولم تُنسخ قاعدة التشغيل. كل
> الاختبارات تستخدم مستودع Git وقاعدة SQLite اصطناعيين داخل مجلدات مؤقتة.

## الغرض

حزمة التعافي مجلد محايد مكتمل ذاتيًا يكفي لاستعادة المشروع على وكيل بديل دون
أي اعتماد على سجل محادثة أو وكيل أو مزود بعينه. الأدوار المشار إليها هي
EXECUTOR وSUPERVISOR فقط.

## مكونات الحزمة

| المسار النسبي | الوصف |
|---|---|
| `manifest.json` | بيان الحزمة المنظم (انظر البنية أدناه) |
| `SHA256SUMS` | بصمات SHA‑256 لكل الملفات النهائية غير الدائرية |
| `RESUME_HERE.md` | صفحة الاستئناف المولدة من الحالة الفعلية |
| `repo.bundle` | Git bundle يحتوي `refs/heads/main` وتاريخه القابل للاستعادة |
| `database.sqlite` | نسخة SQLite متسقة (انظر طريقة النسخ أدناه) |
| `docs/RECOVERY_BUNDLE.md` | هذا الدليل |
| `docs/REPLACEMENT_EXECUTOR_PROMPT.md` | رسالة المنفّذ البديل المحايدة |
| `docs/REPLACEMENT_SUPERVISOR_PROMPT.md` | رسالة المشرف البديلة المحايدة |

لا تُضمَّن ملفات Git غير المتتبعة تلقائيًا، ولا أسرار، ولا `node_modules`، ولا
ملفات تعريف المتصفح، ولا المرفقات أو التنزيلات.

## الإنشاء

```
node scripts/create-recovery-bundle.mjs \
  --project-root "<PROJECT_ROOT>" \
  --sqlite-path "<SQLITE_PATH>" \
  --output-dir "<RECOVERY_BUNDLE_DIR>"
```

- كل المسارات تُمرَّر صراحة؛ لا افتراضات صامتة.
- يُرفض مجلد الإخراج المفقود الأب، أو الموجود مسبقًا، أو الواقع داخل مجلد
  المشروع (حتى لا يلوث Git)، أو أي مسار مصدر مفقود.
- تُبنى الحزمة في مجلد staging مجاور ثم تُنقل ذريًا باسم نهائي واحد.
- عند أي فشل يُترك مجلد الإخراج حاملًا علامة `BUNDLE_FAILED.txt` فقط، ولا
  يُنتج manifest ولا يمكن أن يمر في التحقق.

## التحقق بأمر واحد

```
npm run recovery:verify -- "<RECOVERY_BUNDLE_DIR>"
```

يعيد exit code صفرًا عند السلامة وغير صفر عند أي فشل. الفحوص بالترتيب:

1. غياب علامة الفشل ووجود manifest سليم البنية.
2. تطابق بصمات SHA‑256 لكل ملف مسجل (قبل فتح أي ملف تنفيذي أو قاعدة بيانات).
3. غياب أي ملف زائد غير مسجل ووجود كل ملف مسجل.
4. `git bundle verify` ثم clone داخل مجلد مؤقت، وتطابق HEAD المستعاد مع manifest.
5. `PRAGMA quick_check` لنسخة SQLite، وتطابق schemaVersion وأعداد السجلات.
6. وجود RESUME_HERE ورسالتي البدلاء، وتطابق Hash المذكور في RESUME_HERE.
7. بوابة الأسرار والمسارات الشخصية (أدناه).

## بنية manifest.json

```json
{
  "manifestVersion": "recovery-bundle-manifest-v1",
  "createdAt": "<ISO-8601>",
  "projectName": "<PROJECT_NAME>",
  "git": {
    "bundleFile": "repo.bundle",
    "ref": "refs/heads/main",
    "headCommit": "<40-hex>"
  },
  "database": {
    "file": "database.sqlite",
    "schemaVersion": 0,
    "tables": { "<table>": 0 }
  },
  "continuity": {
    "lastApprovedFunctionalPhase": "<phase>",
    "continuityPackagePhase": "<phase>",
    "nextPlannedPhase": "<phase>",
    "databaseSchemaVersion": 0
  },
  "documents": {
    "resume": "RESUME_HERE.md",
    "guide": "docs/RECOVERY_BUNDLE.md",
    "executorPrompt": "docs/REPLACEMENT_EXECUTOR_PROMPT.md",
    "supervisorPrompt": "docs/REPLACEMENT_SUPERVISOR_PROMPT.md"
  },
  "files": [{ "path": "<relative>", "sha256": "<64-hex>", "bytes": 0 }],
  "verifyCommand": "npm run recovery:verify -- \"<RECOVERY_BUNDLE_DIR>\""
}
```

- كل المسارات داخل manifest وSHA256SUMS نسبية بفواصل `/` فقط.
- `files` يسجل كل ملف نهائي عدا `manifest.json` و`SHA256SUMS` (دائرية مرجعية).
- `SHA256SUMS` يسجل كل ملف نهائي عدا نفسه، بصيغة `<sha256>  <path>` مرتبة.

## طريقة نسخ SQLite

تُفتح القاعدة المصدر باتصال **للقراءة فقط** ثم يُنفَّذ `VACUUM INTO` إلى ملف
جديد. هذه لقطة متسقة عبر محرك SQLite نفسه (تشمل محتوى WAL)، وليست نسخًا
مباشرًا لملف قاعدة مفتوح. بعد النسخ تُفتح النسخة للقراءة فقط ويُتحقق من
`PRAGMA quick_check` ثم تُقرأ schemaVersion وأعداد السجلات من **النسخة**
لا من الأصل.

## بوابة الأسرار والمسارات الشخصية

تُفحص أسماء الملفات، والمحتوى النصي للملفات النصية، وأسماء جداول وأعمدة
SQLite. القائمة الممنوعة (تطابق جزئي، بلا حساسية لحالة الأحرف اللاتينية):

`password`, `passwd`, `secret`, `token`, `cookie`, `session`, `credential`,
`otp`, `api_key`, `apikey`

والصيغ العربية المكافئة الموثقة: «كلمة المرور»، «كلمة السر»، «رمز سري»،
«بيانات الدخول» (بصيغها بالمسافة أو الشرطة أو الشرطة السفلية).

وفي المحتوى النصي تُكشف أنماط القيم الفعلية: تعيين سر بقيمة، JWT، Bearer،
مفتاح خاص، ترويسة Cookie بقيمة، ومفاتيح المزودين المعروفة. وتُكشف المسارات
الشخصية مثل `<DRIVE>:\Users\<NAME>` و`/home/<name>` و`/Users/<name>`.

- ملفات `.env` بكل صيغها ممنوعة بالاسم.
- لا تُطبع أي قيمة سرية أو مسار شخصي مكتشف في رسالة الخطأ؛ يُعرض مسار ملف
  الحزمة أو اسم الحقل فقط.
- لا توجد قائمة سماح إلا لحالة موثقة بأنها إيجابية كاذبة، وتُقيَّد بمسار الملف
  ونوع النمط معًا.

## حدود هذه المرحلة

- لا تُنشئ P4‑H1A حزمة حقيقية من المشروع الرئيسي ولا تنسخ قاعدة التشغيل.
- لا توضع الحزم ولا النسخ ولا bundle داخل Git.
- صناعة حزمة حقيقية لاحقًا تحتاج مهمة مكتوبة منفصلة وموافقة صريحة.
