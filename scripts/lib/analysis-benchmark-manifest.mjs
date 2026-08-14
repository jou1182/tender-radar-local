// أدوات manifest وحالات منصة المقارنة Offline المحايدة — P4-M0A.
// كل شيء هنا محلي وحتمي: قراءة ملفات benchmark/ وإعادة بناء المستند والأجزاء
// وكتالوج الأدلة من الـfixture نفسه. لا شبكة ولا نماذج ولا مزودون إطلاقًا،
// ولا أي شرط يفضّل اسم نموذج؛ modelId يُعامل كسلسلة محايدة في كل المنصة.
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractAnalysisDocument } from "./analysis-documents.mjs";
import { chunkAnalysisDocument } from "./analysis-chunking.mjs";
import { buildEvidenceCandidateCatalog } from "./analysis-evidence-candidates.mjs";
import { analysisFindingFields } from "./analysis-report.mjs";

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

// ---------- تحقق manifest (مطابق لـ benchmark-manifest.schema.json) ----------
const manifestRootKeys = ["benchmarkVersion", "generatedBy", "cases"];
const manifestCaseKeys = [
  "caseId", "fixtureId", "documentId", "title",
  "fixtureFile", "fixtureSha256", "pageCount", "specFile", "groundTruthFile",
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
  });
  const chunks = chunkAnalysisDocument(document);
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  assertValidBenchmarkGroundTruth(groundTruth, catalog);
  return { manifest, manifestEntry: entry, spec, groundTruth, fixtureBuffer, document, chunks, catalog };
}

// ---------- بناء selection مرجعي من ground-truth (للعينات والتحقق الذاتي) ----------
// ليس ناتج نموذج: statement = expectedValue الموثقة، وevidenceIds = candidateIds
// المحلولة من كتالوج النظام. يمر عبر materializeCanonicalReport كأي selection.
export function buildReferenceSelection(groundTruth) {
  const selection = {
    executiveSummary: `تقرير مرجعي مصطنع للحالة ${groundTruth.caseId} — لأغراض المقارنة Offline فقط.`,
    ...Object.fromEntries(analysisFindingFields.map((field) => [field, []])),
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: [],
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
  }
  selection.decisionEvidenceIds = decisionIds;
  return selection;
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
