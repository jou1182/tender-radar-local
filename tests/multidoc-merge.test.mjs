// P5-MULTIDOC-MERGE: اختبارات معزولة (بلا ملفات، بلا Ollama، بلا شبكة) لمنطق
// دمج تقارير التحليل متعدد الملفات. كان هذا المنطق مدفونًا داخل
// scripts/lib/run-multidoc-analysis.mjs (سكربت تحليل حي) بلا أي تغطية اختبارية —
// فاستُخرج إلى وحدة نقية قابلة للتحقق المستقل.
import test from "node:test";
import assert from "node:assert/strict";
import { mergeMultidocReports } from "../scripts/lib/analysis-multidoc-merge.mjs";

// مُنشئ نتيجة ملف اصطناعية — يشبه ما يرجعه السكربت لكل ملف.
function fileResult(over = {}) {
  return {
    fileName: "a.pdf",
    sizeBytes: 100,
    status: "complete",
    evidenceSufficiency: "insufficient",
    confidence: "low",
    evidenceCount: 0,
    sufficiencyEvidenceIds: [],
    evidence: [],
    ...over,
  };
}

test("MULTIDOC-MERGE: أقوى كفاية تفوز بغضّ النظر عن ترتيب الملفات", () => {
  const partialFirst = mergeMultidocReports([
    fileResult({ fileName: "p.pdf", evidenceSufficiency: "partial", confidence: "high", evidenceCount: 1, sufficiencyEvidenceIds: ["ev-p-1"] }),
    fileResult({ fileName: "s.pdf", evidenceSufficiency: "sufficient", confidence: "low", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-s-1", "ev-s-2"] }),
  ]);
  assert.equal(partialFirst.evidenceSufficiency, "sufficient");
  assert.equal(partialFirst.confidence, "low", "ثقة الملف الأقوى كفاية تُعتمد كما هي");

  const sufficientFirst = mergeMultidocReports([
    fileResult({ fileName: "s.pdf", evidenceSufficiency: "sufficient", confidence: "low", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-s-1", "ev-s-2"] }),
    fileResult({ fileName: "p.pdf", evidenceSufficiency: "partial", confidence: "high", evidenceCount: 1, sufficiencyEvidenceIds: ["ev-p-1"] }),
  ]);
  assert.equal(sufficientFirst.evidenceSufficiency, "sufficient", "الترتيب لا يغيّر النتيجة");
  assert.equal(sufficientFirst.confidence, "low");
});

test("MULTIDOC-MERGE: عند التساوي في الكفاية تُعتمد الثقة الأعلى", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "low.pdf", evidenceSufficiency: "partial", confidence: "low", evidenceCount: 1 }),
    fileResult({ fileName: "high.pdf", evidenceSufficiency: "partial", confidence: "high", evidenceCount: 3 }),
  ]);
  assert.equal(merged.evidenceSufficiency, "partial");
  assert.equal(merged.confidence, "high");
});

test("MULTIDOC-MERGE: الملفات الفاشلة تُدرج ولا تساهم بأي دليل أو أدلة كفاية", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "bad.pdf", error: "AI_OUTPUT_INVALID", message: "مخرجات غير صالحة", evidenceSufficiency: "sufficient", confidence: "high", evidenceCount: 9, sufficiencyEvidenceIds: ["ev-bad-1"] }),
    fileResult({ fileName: "ok1.pdf", evidenceSufficiency: "partial", confidence: "medium", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-ok-1", "ev-ok-2"] }),
    fileResult({ fileName: "ok2.pdf", evidenceSufficiency: "partial", confidence: "medium", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-ok-3", "ev-ok-4"] }),
  ]);
  assert.equal(merged.evidenceSufficiency, "partial", "الملف الفاشل لا يرفع الكفاية");
  assert.equal(merged.confidence, "medium");
  assert.deepEqual(merged.errors, [{ fileName: "bad.pdf", code: "AI_OUTPUT_INVALID", message: "مخرجات غير صالحة" }]);
  assert.deepEqual(merged.sufficiencyEvidenceIds, ["ev-ok-1", "ev-ok-2", "ev-ok-3", "ev-ok-4"], "لا معرفات من الملف الفاشل");
  assert.ok(!("bad.pdf" in merged.perFileEvidence), "لا أدلة مسجلة للملف الفاشل");
  const badRow = merged.files.find((f) => f.fileName === "bad.pdf");
  assert.equal(badRow.error, "AI_OUTPUT_INVALID", "الملف الفاشل يظهر في files[] برمز خطئه");
});

test("MULTIDOC-MERGE: الملف الفاشل يُحسب «غير مساهم» في التغطية (صدق التغطية)", () => {
  // سلوك مقصود: ملف تعذّر تحليله لم يُسهم بأدلة فعلًا — فوجوده مع ملف واحد ناجح
  // يعني هيمنة 100% وبالتالي تخفيض الثقة وتحذير صريح، لا ثقة عالية مضللة.
  const merged = mergeMultidocReports([
    fileResult({ fileName: "bad.pdf", error: "DOCUMENT_NO_TEXT", message: "بلا نص" }),
    fileResult({ fileName: "ok.pdf", evidenceSufficiency: "sufficient", confidence: "high", evidenceCount: 5 }),
  ]);
  assert.equal(merged.evidenceSufficiency, "sufficient");
  assert.equal(merged.confidence, "low", "الهيمنة الناتجة عن فشل ملف تخفض الثقة");
  assert.equal(merged.coverageWarning, "التغطية غير متوازنة: 1 من 2 ملفات لم تساهم بأدلة");
});

test("MULTIDOC-MERGE: اتحاد معرفات الأدلة بلا تكرار مع تتبّع مصدر كل دليل", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "first.pdf", evidenceSufficiency: "partial", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-shared", "ev-a"] }),
    fileResult({ fileName: "second.pdf", evidenceSufficiency: "partial", evidenceCount: 2, sufficiencyEvidenceIds: ["ev-shared", "ev-b"] }),
  ]);
  assert.deepEqual(merged.sufficiencyEvidenceIds, ["ev-shared", "ev-a", "ev-b"], "المرجع المشترك مرة واحدة بترتيب أول ظهور");
  assert.equal(merged.sufficiencyEvidenceFileMap["ev-shared"], "first.pdf", "المصدر = أول ملف أسهم بالمعرف");
  assert.equal(merged.sufficiencyEvidenceFileMap["ev-b"], "second.pdf");
});

test("MULTIDOC-MERGE: perFileEvidence يحفظ المقتطف والصفحة لكل دليل بملفه", () => {
  const merged = mergeMultidocReports([
    fileResult({
      fileName: "x.pdf",
      evidenceSufficiency: "partial",
      evidenceCount: 1,
      sufficiencyEvidenceIds: ["ev-x-1"],
      evidence: [{ evidenceId: "ev-x-1", pageNumber: 3, excerpt: "مقتطف حرفي", extra: "يُهمل" }],
    }),
  ]);
  assert.deepEqual(merged.perFileEvidence["x.pdf"], [
    { evidenceId: "ev-x-1", pageNumber: 3, excerpt: "مقتطف حرفي" },
  ]);
  assert.equal(merged.sufficiencyEvidenceFileMap["ev-x-1"], "x.pdf");
});

test("MULTIDOC-MERGE: إجمالي الأدلة يجمع كل الملفات (والفاشل صفر)", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "a.pdf", evidenceCount: 4 }),
    fileResult({ fileName: "b.pdf", evidenceCount: 0 }),
    fileResult({ fileName: "bad.pdf", error: "FAILED", message: "تعذر" }),
  ]);
  assert.equal(merged.totalEvidence, 4);
  assert.equal(merged.files.length, 3, "كل الملفات تظهر في files[]");
});

test("MULTIDOC-MERGE: هيمنة ملف واحد (≥80%) تخفض الثقة إلى low مع تحذير صريح", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "dominant.pdf", evidenceSufficiency: "sufficient", confidence: "high", evidenceCount: 9 }),
    fileResult({ fileName: "small.pdf", evidenceSufficiency: "insufficient", confidence: "low", evidenceCount: 1 }),
    fileResult({ fileName: "zero.pdf", evidenceCount: 0 }),
  ]);
  assert.equal(merged.coverageAssessment.dominant, true);
  assert.equal(merged.coverageAssessment.dominantRatio, 0.9);
  assert.equal(merged.confidence, "low", "الهيمنة تخفض الثقة حتى لو كانت الأدلة كافية");
  assert.equal(merged.coverageWarning, "التغطية غير متوازنة: 1 من 3 ملفات لم تساهم بأدلة");
});

test("MULTIDOC-MERGE: ملفان بلا أدلة يكفيان للتحذير حتى بلا هيمنة", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "a.pdf", evidenceCount: 2 }),
    fileResult({ fileName: "b.pdf", evidenceCount: 2 }),
    fileResult({ fileName: "c.pdf", evidenceCount: 0 }),
    fileResult({ fileName: "d.pdf", evidenceCount: 0 }),
  ]);
  assert.equal(merged.coverageAssessment.dominant, false);
  assert.equal(merged.coverageAssessment.tooManyZero, true);
  assert.equal(merged.confidence, "low");
  assert.equal(merged.coverageWarning, "التغطية غير متوازنة: 2 من 4 ملفات لم تساهم بأدلة");
});

test("MULTIDOC-MERGE: تغطية متوازنة لا تخفض الثقة ولا تُصدر تحذيرًا", () => {
  const merged = mergeMultidocReports([
    fileResult({ fileName: "a.pdf", evidenceSufficiency: "sufficient", confidence: "high", evidenceCount: 4 }),
    fileResult({ fileName: "b.pdf", evidenceSufficiency: "partial", confidence: "medium", evidenceCount: 4 }),
  ]);
  assert.equal(merged.coverageAssessment.unbalanced, false);
  assert.equal(merged.confidence, "high");
  assert.equal(merged.coverageWarning, undefined, "لا تحذير عند التوازن");
});

test("MULTIDOC-MERGE: مدخل فارغ يعطي كفاية غير كافية وثقة منخفضة بلا تحذير", () => {
  const merged = mergeMultidocReports([]);
  assert.equal(merged.evidenceSufficiency, "insufficient");
  assert.equal(merged.confidence, "low");
  assert.equal(merged.totalEvidence, 0);
  assert.deepEqual(merged.sufficiencyEvidenceIds, []);
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.coverageWarning, undefined);
});
