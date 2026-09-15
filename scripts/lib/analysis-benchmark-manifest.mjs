// أدوات manifest وحالات منصة المقارنة Offline المحايدة — P4-M0A.
// كل شيء هنا محلي وحتمي: قراءة ملفات benchmark/ وإعادة بناء المستند والأجزاء
// وكتالوج الأدلة من الـfixture نفسه. لا شبكة ولا نماذج ولا مزودون إطلاقًا،
// ولا أي شرط يفضّل اسم نموذج؛ modelId يُعامل كسلسلة محايدة في كل المنصة.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractAnalysisDocument } from "./analysis-documents.mjs";
import { chunkAnalysisDocument } from "./analysis-chunking.mjs";
import { buildEvidenceCandidateCatalog } from "./analysis-evidence-candidates.mjs";
import { analysisFindingFields, validateAnalysisReport } from "./analysis-report.mjs";

export const benchmarkVersion = "analysis-benchmark-v1";
export const benchmarkGroundTruthVersion = "benchmark-ground-truth-v1";
export const benchmarkFixtureSpecVersion = "benchmark-fixture-spec-v1";

// علامة إلزامية على كل صفحة من كل fixture: بيانات اصطناعية لا تُستخدم إلا للاختبار.
export const benchmarkFixtureMarker = "بيانات اختبار اصطناعية — ليست منافسة حقيقية";

// الفئات الواقعية: ما عدا فئتي الغموض والأسئلة (تحكمهما قواعد خاصة في المُقيّم).
export const benchmarkFactualCategories = Object.freeze(
  analysisFindingFields.filter((field) => field !== "unclearItems" && field !== "questionsForAuthority"),
);
export const benchmarkAmbiguityCategories = Object.freeze(["unclearItems", "questionsForAuthority"]);
export const availabilityValues = Object.freeze(["explicit", "conflicting", "missing"]);

export function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------- بصمة كتالوج الأدلة: تسلسل canonical حتمي + SHA-256 ----------
// تربط manifest وground-truth بالكتالوج الفعلي الناتج من الـfixture؛ أي تغيير
// في مقتطف أو معرف أو ترتيب أو موقع يغيّر البصمة فيرفض المقيّم الكتالوج الأجنبي.
//
// الشكل canonical (P4-M0AR2): 13 حقلًا بترتيب ثابت وصريح، لا يعتمد على ترتيب
// خصائص JavaScript — يُبنى نص JSON يدويًا حقلًا حقلًا. الحقول الاختيارية
// الغائبة تُمثَّل بـ null حتميًا. أي حقل إضافي غير معروف أو نوع خاطئ يرمي
// BENCHMARK_CATALOG_INVALID فيسقط الكتالوج في INVALID_BENCHMARK_INPUT.
export const catalogFingerprintFieldSpec = Object.freeze([
  { key: "index", kind: "integer" },
  { key: "candidateId", kind: "string" },
  { key: "documentId", kind: "string" },
  { key: "sourceType", kind: "string" },
  { key: "excerpt", kind: "string" },
  { key: "chunkId", kind: "string" },
  { key: "blockId", kind: "string" },
  { key: "startOffset", kind: "integer" },
  { key: "endOffset", kind: "integer" },
  { key: "pageNumber", kind: "integer|null" },
  { key: "sheetName", kind: "string|null" },
  { key: "cellRange", kind: "string|null" },
  { key: "section", kind: "string|null" },
]);
const catalogCandidateKeys = new Set(catalogFingerprintFieldSpec.map((field) => field.key).filter((key) => key !== "index"));

function catalogInvalid(reason) {
  const error = new Error(`بصمة الكتالوج: ${reason}`);
  error.code = "BENCHMARK_CATALOG_INVALID";
  return error;
}

function catalogFieldValue(candidate, index, { key, kind }) {
  const value = key === "index" ? index : candidate[key];
  if (value === undefined || value === null) {
    if (kind.endsWith("|null")) return null;
    throw catalogInvalid(`الحقل المطلوب ${key} مفقود عند المرشح ${index}.`);
  }
  if (kind.startsWith("string")) {
    if (typeof value !== "string") throw catalogInvalid(`الحقل ${key} عند المرشح ${index} يجب أن يكون نصًا.`);
    return value;
  }
  // integer أو integer|null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw catalogInvalid(`الحقل ${key} عند المرشح ${index} يجب أن يكون عددًا صحيحًا غير سالب.`);
  }
  return value;
}

function catalogFingerprintLine(candidate, index) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw catalogInvalid(`المرشح ${index} ليس كائنًا.`);
  }
  for (const key of Object.keys(candidate)) {
    if (!catalogCandidateKeys.has(key)) {
      throw catalogInvalid(`حقل غير معروف "${key}" عند المرشح ${index} (additionalProperties: false).`);
    }
  }
  // بناء يدوي حقلًا حقلًا بترتيب catalogFingerprintFieldSpec — لا يعتمد على
  // ترتيب خصائص الكائن في JavaScript.
  const pairs = catalogFingerprintFieldSpec.map((spec) => {
    const value = catalogFieldValue(candidate, index, spec);
    const serialized = value === null ? "null" : JSON.stringify(value);
    return `${JSON.stringify(spec.key)}:${serialized}`;
  });
  return `{${pairs.join(",")}}`;
}

export function fingerprintCatalog(catalog) {
  const candidates = catalog?.candidates;
  if (!Array.isArray(candidates)) {
    throw catalogInvalid("فهرسة بصمة الكتالوج تتطلب candidates مصفوفة.");
  }
  const canonical = candidates.map((candidate, index) => catalogFingerprintLine(candidate, index)).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------- أدوات الأرقام: تطبيع واستخراج ادعاءات رقمية canonical ----------
// تُستخدم في بوابة تأسيس الأرقام: كل رقم/تاريخ/نسبة في أي finding يجب أن
// يظهر في مقتطفات أدلة ذلك الـfinding نفسه بعد هذا التطبيع.
const arabicIndicDigits = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const extendedArabicIndicDigits = { "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };

export function normalizeNumericText(value) {
  let text = String(value || "");
  text = text.replace(/[٠-٩]/g, (ch) => arabicIndicDigits[ch]);
  text = text.replace(/[۰-۹]/g, (ch) => extendedArabicIndicDigits[ch]);
  text = text.replace(/٬/g, ",");
  // فواصل الآلاف فقط: رقم بين رقمين بثلاث خانات تالية.
  text = text.replace(/(?<=\d),(?=\d{3}\b)/g, "");
  text = text.replace(/٫/g, ".");
  text = text.replace(/٪/g, "%");
  return text;
}

// استخراج متسلسل مع إخفاء: التواريخ أولًا ثم الأوقات ثم النسب ثم الأرقام،
// حتى لا تُلتقط أجزاء تاريخ كأرقام مستقلة. الحدود (?<![\w.%-]) / (?![\w%-])
// تمنع التقاط أرقام داخل معرفات مثل m0a أو TEST-M0A-001.
export function extractNumericClaims(value) {
  let text = normalizeNumericText(value);
  const claims = [];
  const boundaryBefore = "(?<![\\w.%-])";
  const boundaryAfter = "(?![\\w%-])";
  const patterns = [
    { kind: "date", re: /\d{4}-\d{1,2}-\d{1,2}/g },
    { kind: "date", re: /\d{1,2}\/\d{1,2}\/\d{4}/g },
    { kind: "time", re: /\d{1,2}:\d{2}/g },
    { kind: "percent", re: /\d+(?:\.\d+)?%/g },
    { kind: "number", re: /\d+(?:\.\d+)?/g },
  ];
  for (const { kind, re } of patterns) {
    text = text.replace(new RegExp(`${boundaryBefore}${re.source}${boundaryAfter}`, "g"), (match) => {
      if (kind === "percent") {
        const numeric = match.slice(0, -1);
        claims.push({ kind, raw: match, canonical: `${String(Number(numeric))}%` });
      } else if (kind === "number") {
        claims.push({ kind, raw: match, canonical: String(Number(match)) });
      } else {
        claims.push({ kind, raw: match, canonical: match });
      }
      return " ".repeat(match.length);
    });
  }
  return claims;
}

// كلمات تجعل الجملة "واقعية" في الملخص والتحذيرات: تستلزم تأسيسًا نصيًا.
export const narrativeFactualTriggers = Object.freeze([
  "مدينة", "مبلغ", "مدة", "قيمة", "ريال", "نسبة", "موعد", "ضمان", "غرامة",
  "كمية", "سعر", "مشروع", "عقد", "جهة", "متعاقد", "مقاول", "أهلية", "خبرة",
  "تصنيف", "سجل",
]);

// علامات سياق تعارض/غياب تعفي الجملة من forbiddenAssertions: وصف التعارض
// الموثق ليس ادعاءً محظورًا.
export const conflictContextMarkers = Object.freeze([
  "متعارض", "تعارض", "غير محدد", "لم تحدد", "لم تُحدد", "لم يُحسم", "لم تُحسم",
  "دون حسم", "لا يمكن الجزم", "يحدد لاحقا", "غير مسجل", "غير واضح",
]);

// ---------- تطبيع الادعاءات العربية (P4-M0AR2): حتمي وموثق ----------
// يُستخدم في بوابتي تأسيس findings والسرد: مقارنة كلمات دالة بعد توحيد
// الأشكال، بلا fuzzy matching ولا نسب تشابه.
// الخطوات بالترتيب:
//   1) Unicode NFC.
//   2) إزالة التشكيل (064B–0652 و0670) والتطويل (0640).
//   3) توحيد أشكال الألف (أ إ آ ٱ → ا) والهمزات على الواو/الياء (ؤ→و، ئ→ي)
//      وألف المقصورة (ى→ي) والتاء المربوطة (ة→ه) — توحيد شكلي لا يغير المعنى.
//   4) تطبيع الأرقام كما في normalizeNumericText (أرقام عربية، فواصل، ٪).
//   5) خفض حالة الأحرف اللاتينية (Offline ← offline) — شكلي حتمي بلا أثر على
//      المعنى.
export function normalizeArabicClaimText(value) {
  let text = String(value || "").normalize("NFC").toLowerCase();
  text = text.replace(/[ً-ٰٔـ]/g, "");
  text = text
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");  return normalizeNumericText(text);
}

// معالجة محدودة وموثقة للواصقات العربية الشائعة: عند فحص انتماء كلمة إلى
// corpus نسمح بتجريد ما يصل إلى حرفي وصل متتابعين (و ف ب ل ك — يغطي
// «للحالة» = ل+ل+الحالة و«والتنفيذ») ثم أداة التعريف "ال"، من الطرفين
// (كلمة الادعاء وكلمات الـcorpus). التجريد لا يُنشئ جذرًا جديدًا: الكيان
// المختلق يبقى غير مؤسس.
export function claimTokenVariants(token) {
  const variants = new Set([token]);
  let stripped = token;
  for (let i = 0; i < 2 && stripped.length > 3 && "وفبلك".includes(stripped[0]); i += 1) {
    stripped = stripped.slice(1);
    variants.add(stripped);
  }
  if (token.length > 5 && token.startsWith("ال")) variants.add(token.slice(2));
  if (stripped.length > 3 && stripped.startsWith("ال")) variants.add(stripped.slice(2));
  return variants;
}

// معرفات إطار الاختبار الاصطناعية (معرف الحالة/الـfixture): تظهر في علامة
// الـfixture والميتاداتا ولا تحمل أي ادعاء واقعي، فتُستثنى من الكلمات الدالة.
export function isBenchmarkFrameworkToken(token) {
  return /^(m0a-[a-z]+|test-m0a-\d+)$/i.test(token);
}

// قاموس محلي صغير وثابت لعبارات التقرير المحايدة وإعادة الصياغة الآمنة:
// كلمات وصفية/إطارية فقط، بلا أي كيان واقعي (لا مدن ولا جهات ولا أنشطة ولا
// شروط ولا ضمانات ولا مواقع). تُطبَّع حتميًا عند الاستخدام عبر
// normalizeArabicClaimText وتُوسَّع بمتغيرات الوصل الموثقة.
// إضافات P4-M0AR3 (موثقة): دليل/أدلة/الأدلة (لعبارة «الأدلة الواردة محدودة
// وتحتاج استكمالًا»)، وليس/ناتج (لعبارة التحذير المرجعية الثابتة).
export const neutralReportLexicon = Object.freeze([
  "تقرير", "مرجعي", "مصطنع", "اصطناعي", "مبدئي", "أولي", "للمراجعة", "لأغراض",
  "المقارنة", "الحالة", "النموذج", "فقط", "يستند", "استنادا", "استنادًا", "الواردة",
  "أدناه", "أعلاه", "يلي", "بناء", "بناءً", "موثق", "موثقة", "الموثقة", "بيانات",
  "اختبار", "ليست", "منافسة", "حقيقية", "offline", "مذكور", "مذكورة", "صريح",
  "صريحة", "غير", "محدودة", "تحتاج", "استكمالا", "استكمالًا", "مراجعة", "كما",
  "حرفيا", "حرفيًا", "نصا", "نصًا",
  "دليل", "أدلة", "الأدلة", "ليس", "ناتج",
]);
export const neutralReportLexiconNormalized = Object.freeze(
  [...new Set(neutralReportLexicon.flatMap((word) => {
    const normalized = normalizeSpaces(normalizeArabicClaimText(word));
    return [...claimTokenVariants(normalized)];
  }))],
);

// ---------- تحقق manifest (مطابق لـ benchmark-manifest.schema.json) ----------
const manifestRootKeys = ["benchmarkVersion", "generatedBy", "cases"];
const manifestCaseKeys = [
  "caseId", "fixtureId", "documentId", "title",
  "fixtureFile", "fixtureSha256", "catalogSha256", "pageCount", "specFile", "groundTruthFile",
];

export function validateBenchmarkManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest ليس كائن JSON صالحًا."];
  }
  for (const key of Object.keys(manifest)) {
    if (!manifestRootKeys.includes(key)) errors.push(`حقل غير مسموح في manifest: ${key} (additionalProperties: false).`);
  }
  if (manifest.benchmarkVersion !== benchmarkVersion) errors.push(`benchmarkVersion يجب أن تكون ${benchmarkVersion}.`);
  if (!isNonEmptyString(manifest.generatedBy)) errors.push("generatedBy مفقود.");
  if (!Array.isArray(manifest.cases) || !manifest.cases.length) {
    errors.push("cases يجب أن تكون مصفوفة غير فارغة.");
    return errors;
  }
  const seenCaseIds = new Set();
  manifest.cases.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`cases[${index}] ليس كائنًا.`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!manifestCaseKeys.includes(key)) errors.push(`cases[${index}]: حقل غير مسموح: ${key} (additionalProperties: false).`);
    }
    for (const key of manifestCaseKeys) {
      if (!(key in entry)) errors.push(`cases[${index}]: الحقل المطلوب مفقود: ${key}`);
    }
    if (!isNonEmptyString(entry.caseId) || !/^m0a-[a-z]+$/.test(entry.caseId)) errors.push(`cases[${index}]: caseId غير صالح.`);
    else if (seenCaseIds.has(entry.caseId)) errors.push(`cases[${index}]: caseId مكرر: ${entry.caseId}.`);
    else seenCaseIds.add(entry.caseId);
    if (!isNonEmptyString(entry.fixtureId) || !/^TEST-M0A-\d{3}$/.test(entry.fixtureId)) errors.push(`cases[${index}]: fixtureId غير صالح.`);
    if (!isNonEmptyString(entry.documentId)) errors.push(`cases[${index}]: documentId مفقود.`);
    if (!isNonEmptyString(entry.title)) errors.push(`cases[${index}]: title مفقود.`);
    if (!isNonEmptyString(entry.fixtureFile)) errors.push(`cases[${index}]: fixtureFile مفقود.`);
    if (!isNonEmptyString(entry.fixtureSha256) || !/^[0-9a-f]{64}$/.test(entry.fixtureSha256)) errors.push(`cases[${index}]: fixtureSha256 غير صالح.`);
    if (!isNonEmptyString(entry.catalogSha256) || !/^[0-9a-f]{64}$/.test(entry.catalogSha256)) errors.push(`cases[${index}]: catalogSha256 غير صالح.`);
    if (!Number.isInteger(entry.pageCount) || entry.pageCount < 1) errors.push(`cases[${index}]: pageCount غير صالح.`);
    if (!isNonEmptyString(entry.specFile)) errors.push(`cases[${index}]: specFile مفقود.`);
    if (!isNonEmptyString(entry.groundTruthFile)) errors.push(`cases[${index}]: groundTruthFile مفقود.`);
  });
  return errors;
}

export function assertValidBenchmarkManifest(manifest) {
  const errors = validateBenchmarkManifest(manifest);
  if (errors.length) {
    const error = new Error(`manifest المنصة غير صالح: ${errors[0]}`);
    error.code = "BENCHMARK_MANIFEST_INVALID";
    error.details = errors;
    throw error;
  }
  return manifest;
}

// ---------- تحقق ground-truth مقابل الكتالوج الفعلي ----------
export function validateBenchmarkGroundTruth(groundTruth, catalog) {
  const errors = [];
  if (!groundTruth || typeof groundTruth !== "object" || Array.isArray(groundTruth)) {
    return ["ground-truth ليس كائن JSON صالحًا."];
  }
  if (groundTruth.groundTruthVersion !== benchmarkGroundTruthVersion) {
    errors.push(`groundTruthVersion يجب أن تكون ${benchmarkGroundTruthVersion}.`);
  }
  for (const key of ["caseId", "fixtureId", "documentId", "fixtureSha256"]) {
    if (!isNonEmptyString(groundTruth[key])) errors.push(`ground-truth: ${key} مفقود.`);
  }
  if (isNonEmptyString(groundTruth.fixtureSha256) && !/^[0-9a-f]{64}$/.test(groundTruth.fixtureSha256)) {
    errors.push("ground-truth: fixtureSha256 غير صالح.");
  }
  if (!isNonEmptyString(groundTruth.catalogSha256) || !/^[0-9a-f]{64}$/.test(groundTruth.catalogSha256 || "")) {
    errors.push("ground-truth: catalogSha256 مفقود أو غير صالح.");
  } else if (catalog) {
    // كتالوج تالف البنية (حقل مجهول/نوع خاطئ) يرمي BENCHMARK_CATALOG_INVALID؛
    // يُعامل كعدم تطابق بصمة لا كاستثناء هارب.
    let actualFingerprint = null;
    try {
      actualFingerprint = fingerprintCatalog(catalog);
    } catch {
      actualFingerprint = null;
    }
    if (actualFingerprint !== groundTruth.catalogSha256) {
      errors.push("ground-truth: catalogSha256 لا يطابق بصمة الكتالوج الفعلي.");
    }
  }
  if (groundTruth.allowDerivedNumericClaims !== undefined && typeof groundTruth.allowDerivedNumericClaims !== "boolean") {
    errors.push("ground-truth: allowDerivedNumericClaims يجب أن تكون منطقية عند وجودها.");
  }
  const catalogIds = new Set((catalog?.candidates || []).map((candidate) => candidate.candidateId));
  const expectations = groundTruth.expectedFindings;
  if (!Array.isArray(expectations) || !expectations.length) {
    errors.push("expectedFindings يجب أن تكون مصفوفة غير فارغة.");
  } else {
    const seenIds = new Set();
    expectations.forEach((expectation, index) => {
      const label = expectation?.expectedId || `expectedFindings[${index}]`;
      if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
        errors.push(`${label}: ليس كائنًا.`);
        return;
      }
      if (!isNonEmptyString(expectation.expectedId)) errors.push(`${label}: expectedId مفقود.`);
      else if (seenIds.has(expectation.expectedId)) errors.push(`${label}: expectedId مكرر.`);
      else seenIds.add(expectation.expectedId);
      if (!analysisFindingFields.includes(expectation.category)) errors.push(`${label}: category غير معروفة.`);
      if (!isNonEmptyString(expectation.expectedValue)) errors.push(`${label}: expectedValue مفقودة.`);
      if (typeof expectation.required !== "boolean") errors.push(`${label}: required يجب أن تكون منطقية.`);
      if (!availabilityValues.includes(expectation.availability)) errors.push(`${label}: availability غير صالحة.`);
      if (!Array.isArray(expectation.criticalTerms) || !expectation.criticalTerms.length
        || !expectation.criticalTerms.every(isNonEmptyString)) {
        errors.push(`${label}: criticalTerms يجب أن تكون مصفوفة نصوص غير فارغة.`);
      } else {
        const normalizedValue = normalizeSpaces(expectation.expectedValue);
        for (const term of expectation.criticalTerms) {
          if (!normalizedValue.includes(normalizeSpaces(term))) {
            errors.push(`${label}: المصطلح الحرج "${term}" غير موجود في expectedValue.`);
          }
        }
      }
      if (!Array.isArray(expectation.candidateIds) || !expectation.candidateIds.length) {
        errors.push(`${label}: candidateIds يجب أن تكون مصفوفة غير فارغة من كتالوج النظام.`);
      } else {
        for (const id of expectation.candidateIds) {
          if (!catalogIds.has(id)) errors.push(`${label}: candidateId غير موجود في الكتالوج الناتج: ${id}.`);
        }
      }
    });
  }
  const forbidden = groundTruth.forbiddenAssertions;
  if (!Array.isArray(forbidden)) {
    errors.push("forbiddenAssertions يجب أن تكون مصفوفة (قد تكون فارغة).");
  } else {
    forbidden.forEach((assertion, index) => {
      const label = assertion?.assertionId || `forbiddenAssertions[${index}]`;
      if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
        errors.push(`${label}: ليس كائنًا.`);
        return;
      }
      if (!isNonEmptyString(assertion.assertionId)) errors.push(`${label}: assertionId مفقود.`);
      if (!Array.isArray(assertion.terms) || !assertion.terms.length || !assertion.terms.every(isNonEmptyString)) {
        errors.push(`${label}: terms يجب أن تكون مصفوفة نصوص غير فارغة.`);
      }
      if (assertion.categories !== undefined
        && (!Array.isArray(assertion.categories) || !assertion.categories.every((c) => benchmarkFactualCategories.includes(c)))) {
        errors.push(`${label}: categories يجب أن تكون فئات واقعية معروفة.`);
      }
      if (!isNonEmptyString(assertion.reason)) errors.push(`${label}: reason مفقود.`);
    });
  }
  return errors;
}

export function assertValidBenchmarkGroundTruth(groundTruth, catalog) {
  const errors = validateBenchmarkGroundTruth(groundTruth, catalog);
  if (errors.length) {
    const error = new Error(`ground-truth غير صالح: ${errors[0]}`);
    error.code = "BENCHMARK_GROUND_TRUTH_INVALID";
    error.details = errors;
    throw error;
  }
  return groundTruth;
}

// ---------- تحميل الحالة: manifest + spec + ground-truth + fixture + كتالوج ----------
export function loadBenchmarkManifest(benchmarkRoot) {
  const manifestPath = path.join(benchmarkRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return assertValidBenchmarkManifest(manifest);
}

export function loadBenchmarkCase(benchmarkRoot, caseId) {
  const manifest = loadBenchmarkManifest(benchmarkRoot);
  const entry = manifest.cases.find((item) => item.caseId === caseId);
  if (!entry) {
    const error = new Error(`حالة مقارنة غير معروفة: ${caseId}`);
    error.code = "BENCHMARK_CASE_UNKNOWN";
    throw error;
  }
  const spec = JSON.parse(readFileSync(path.join(benchmarkRoot, entry.specFile), "utf8"));
  const groundTruth = JSON.parse(readFileSync(path.join(benchmarkRoot, entry.groundTruthFile), "utf8"));
  const fixtureBuffer = readFileSync(path.join(benchmarkRoot, entry.fixtureFile));
  const document = extractAnalysisDocument({
    documentId: entry.documentId,
    fileName: path.basename(entry.fixtureFile),
    buffer: fixtureBuffer,
    applyRtlFix: false,
  });
  const chunks = chunkAnalysisDocument(document);
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  assertValidBenchmarkGroundTruth(groundTruth, catalog);
  return { manifest, manifestEntry: entry, spec, groundTruth, fixtureBuffer, document, chunks, catalog };
}

// ---------- بناء selection مرجعي من ground-truth (للعينات والتحقق الذاتي) ----------
// مرجع مُصنّع من بيانات ground-truth المعتمدة — ليس ناتج نموذج إطلاقًا. لا يمر
// عبر مسار النموذج الصارم (analysis-model-selection-v3) الذي يمنع أي نص حر؛
// referenceReport تُبنى منه مباشرة عبر materializeReferenceReport لأنها بيانات
// مرجعية لاختبار المُقيّم نفسه (تغطي أيضًا عبارات التعارض الموثقة التي لا تظهر
// حرفيًا في مقتطفات الأدلة، مثل «مدة التنفيذ متعارضة بين الصفحتين»).
export function buildReferenceSelection(groundTruth) {
  const selection = {
    executiveSummary: `تقرير مرجعي مصطنع للحالة ${groundTruth.caseId} — لأغراض المقارنة Offline فقط.`,
    ...Object.fromEntries(analysisFindingFields.map((field) => [field, []])),
    evidenceSufficiency: "partial",
    confidence: "medium",
    sufficiencyEvidenceIds: [],
    warnings: ["تقرير مرجعي مصطنع لأغراض المقارنة Offline فقط؛ ليس ناتج نموذج."],
  };
  const decisionIds = [];
  for (const expectation of groundTruth.expectedFindings) {
    selection[expectation.category].push({
      category: expectation.category,
      statement: expectation.expectedValue,
      severity: expectation.category === "unclearItems"
        ? "high"
        : expectation.category === "questionsForAuthority" ? "info" : "medium",
      confidence: expectation.availability === "explicit" ? "high" : "medium",
      evidenceIds: [...expectation.candidateIds],
    });
    if (!decisionIds.length && expectation.candidateIds.length) decisionIds.push(expectation.candidateIds[0]);
    // قيم التوقعات المتعارضة/المفقودة تُضاف إلى التحذيرات المرجعية حتى تكون
    // أوصاف التعارض الموثقة (مثل "متعارضة: 90 يومًا و120 يومًا") مؤسسة نصيًا.
    if (expectation.availability === "conflicting" || expectation.availability === "missing") {
      selection.warnings.push(expectation.expectedValue);
    }
  }
  selection.sufficiencyEvidenceIds = decisionIds;
  return selection;
}

// يُبني التقرير المرجعي من selection مرجعي: يبني evidence من الكتالوج حرفيًا
// ثم يتحقق من صحة analysis-report-v3 فقط — بلا تقييد نصي لأن المصدر
// ground-truth معتمد وليس ناتج نموذج. يُستخدم حصريًا في منصة المقارنة Offline.
export function materializeReferenceReport(selection, catalog) {
  const candidates = (catalog && Array.isArray(catalog.candidates)) ? catalog.candidates : [];
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const usedIds = [];
  const seen = new Set();
  const collect = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      usedIds.push(id);
    }
  };
  const report = {
    executiveSummary: selection.executiveSummary,
    evidenceSufficiency: selection.evidenceSufficiency,
    confidence: selection.confidence,
    sufficiencyEvidenceIds: [...selection.sufficiencyEvidenceIds],
    warnings: [...selection.warnings],
  };
  for (const field of analysisFindingFields) {
    report[field] = (Array.isArray(selection[field]) ? selection[field] : []).map((finding) => {
      for (const id of finding.evidenceIds) collect(id);
      return {
        category: finding.category,
        statement: finding.statement,
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceIds: [...finding.evidenceIds],
      };
    });
  }
  for (const id of selection.sufficiencyEvidenceIds) collect(id);
  report.evidence = usedIds.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      const error = new Error(`معرف دليل مجهول لا يوجد في كتالوج المرشحين: ${id}`);
      error.code = "AI_OUTPUT_INVALID";
      throw error;
    }
    return {
      evidenceId: candidate.candidateId,
      documentId: candidate.documentId,
      sourceType: candidate.sourceType,
      ...(candidate.pageNumber !== undefined ? { pageNumber: candidate.pageNumber } : {}),
      ...(candidate.sheetName !== undefined ? { sheetName: candidate.sheetName, cellRange: candidate.cellRange } : {}),
      ...(candidate.section !== undefined ? { section: candidate.section } : {}),
      excerpt: candidate.excerpt,
      chunkId: candidate.chunkId,
    };
  });
  const reportErrors = validateAnalysisReport(report);
  if (reportErrors.length) {
    const error = new Error(`فشل الفحص الذاتي للتقرير المرجعي: ${reportErrors[0]}`);
    error.code = "BENCHMARK_REFERENCE_INVALID";
    error.details = reportErrors;
    throw error;
  }
  return report;
}

// يحل معرفات المرشحين من مقتطفات موثقة في spec: يجب أن يطابق كل مقتطف
// مرشحًا واحدًا في الكتالوج تمامًا، وإلا يفشل التوليد — لا معرفات يدوية.
export function resolveExpectationCandidateIds(expectation, catalog) {
  const excerpts = expectation.evidenceExcerpts
    ? expectation.evidenceExcerpts
    : [expectation.evidenceExcerpt];
  if (!Array.isArray(excerpts) || !excerpts.length || !excerpts.every(isNonEmptyString)) {
    const error = new Error(`التوقع ${expectation.expectedId || "?"}: evidenceExcerpt(s) مفقودة في spec.`);
    error.code = "BENCHMARK_SPEC_INVALID";
    throw error;
  }
  const ids = [];
  for (const excerpt of excerpts) {
    const normalized = normalizeSpaces(excerpt);
    const matches = catalog.candidates.filter((candidate) => candidate.excerpt === normalized);
    if (matches.length !== 1) {
      const error = new Error(
        `التوقع ${expectation.expectedId || "?"}: المقتطف يطابق ${matches.length} مرشحًا (المطلوب 1 بالضبط): "${normalized.slice(0, 60)}…"`,
      );
      error.code = "BENCHMARK_SPEC_INVALID";
      throw error;
    }
    if (!ids.includes(matches[0].candidateId)) ids.push(matches[0].candidateId);
  }
  return ids;
}
