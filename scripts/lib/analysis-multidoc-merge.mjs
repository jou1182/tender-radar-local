// P5-MULTIDOC-MERGE: دمج تقارير تحليل الملفات المتعددة — دالة نقية بلا I/O
// وبلا شبكة وبلا نموذج، ليكون منطق الدمج قابلًا للاختبار المعزول والمراجعة المستقلة.
// كان هذا المنطق مضمّنًا داخل scripts/lib/run-multidoc-analysis.mjs (سكربت تحليل
// حي لا تغطية اختبارية له)، فنُقل هنا كما هو حرفيًا في الدلالة:
//   1. أقوى كفاية أدلة تفوز، وعند التعادل تُعتمد الثقة الأعلى.
//   2. اتحاد معرفات أدلة الكفاية بلا تكرار مع تتبّع مصدر كل دليل لملفه.
//   3. بوابة توازن التغطية تُطبَّق بعد الدمج: هيمنة ملف واحد (≥ العتبة) أو ملفان
//      بلا أدلة ⇒ تخفيض الثقة إلى low مع تحذير صريح (صدق التغطية).
import { assessCoverageBalance, coverageWarningMessage } from "./analysis-quality-gates.mjs";

export const sufficiencyRank = { sufficient: 2, partial: 1, insufficient: 0 };
export const confidenceRank = { high: 3, medium: 2, low: 1 };

export function mergeMultidocReports(perFileResults = [], { dominantThreshold = 0.8 } = {}) {
  const results = Array.isArray(perFileResults) ? perFileResults : [];
  const merged = {
    evidenceSufficiency: "insufficient",
    confidence: "low",
    sufficiencyEvidenceIds: [],
    files: results.map((r) => ({
      fileName: r.fileName,
      sizeBytes: r.sizeBytes,
      evidenceSufficiency: r.evidenceSufficiency,
      confidence: r.confidence,
      evidenceCount: r.evidenceCount,
      error: r.error,
    })),
    perFileEvidence: {},
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ fileName: r.fileName, code: r.error, message: r.message })),
  };

  const sufficiencyFileMap = {};
  for (const r of results) {
    if (r.error) continue;
    const rank = sufficiencyRank[r.evidenceSufficiency] ?? 0;
    if (rank > (sufficiencyRank[merged.evidenceSufficiency] ?? 0)) {
      merged.evidenceSufficiency = r.evidenceSufficiency;
      merged.confidence = r.confidence;
    } else if (rank === (sufficiencyRank[merged.evidenceSufficiency] ?? 0)) {
      if ((confidenceRank[r.confidence] ?? 0) > (confidenceRank[merged.confidence] ?? 0)) merged.confidence = r.confidence;
    }
    for (const id of r.sufficiencyEvidenceIds || []) {
      if (!merged.sufficiencyEvidenceIds.includes(id)) {
        merged.sufficiencyEvidenceIds.push(id);
        sufficiencyFileMap[id] = r.fileName;
      }
    }
    merged.perFileEvidence[r.fileName] = (r.evidence || []).map((e) => ({
      evidenceId: e.evidenceId,
      pageNumber: e.pageNumber,
      excerpt: e.excerpt,
    }));
  }
  merged.totalEvidence = results.reduce((sum, r) => sum + (r.evidenceCount || 0), 0);
  merged.sufficiencyEvidenceFileMap = sufficiencyFileMap;

  // P5-QGATE: فحص هيمنة ملف واحد بعد الدمج — ملف فشل تحليله يُحسب هنا غير مساهم
  // (لم يُنتج أدلة فعلًا)، وهذا مقصود: تغطية صادقة لا ثقة عالية مضللة.
  const perFileCounts = {};
  for (const r of results) perFileCounts[r.fileName] = r.evidenceCount || 0;
  const coverage = assessCoverageBalance(perFileCounts, { dominantThreshold });
  merged.coverageAssessment = coverage;
  if (coverage.unbalanced) {
    merged.confidence = "low";
    merged.coverageWarning = coverageWarningMessage(coverage);
  }
  return merged;
}
