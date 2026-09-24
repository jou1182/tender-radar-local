// P5-MULTIDOC: تحليل حي للملفات الأربعة لمنافسة واحدة، ثم دمج التقارير.
// كل مستند يُحلَّل عبر المسار الأحادي المعتمد (سياق كامل)، ثم تُدمج النتائج
// في تقرير موحّد. الدمج على مستوى التقرير — لا على مستوى كتالوج مشوّه.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRadarRepository } from "./radar-repository.mjs";
import { runTrustedDocumentAnalysis } from "./trusted-document-cli.mjs";
import { extractAnalysisDocument } from "./analysis-documents.mjs";
import { needsAlternateExtraction } from "./analysis-quality-gates.mjs";
import { mergeMultidocReports } from "./analysis-multidoc-merge.mjs";

const TENDER = process.argv[2] || "260839003247";
const env = {
  ...process.env,
  RADAR_AI_ENABLED: "true",
  RADAR_AI_PROVIDER: "ollama",
  OLLAMA_MODEL: "nemotron-3.5-lightning:latest",
  OLLAMA_URL: "http://127.0.0.1:11434",
};
const projectRoot = path.resolve(".");
const repository = await createRadarRepository({ projectRoot });
const metas = repository.listAttachmentMeta(TENDER).filter((a) => a.downloadStatus === "downloaded");
repository.close();

const t0 = Date.now();
const results = [];
for (const meta of metas) {
  const buf = await readFile(meta.localPath);
  const sha = createHash("sha256").update(buf).digest("hex");
  const localStoredName = path.basename(meta.localPath);
  console.log(`\n=== تحليل: ${meta.displayName.slice(0, 50)} (${meta.size} بايت) ===`);

  // P5-QGATE: فحص العطب المتبقي بعد كل المسارات البديلة (poppler + pymupdf) —
  // ملف ما زال معطوبًا (تجزئة أو فقدان محتوى عربي) يُستبعد من الأدلة.
  let fragmented = false;
  try {
    const probe = extractAnalysisDocument({ documentId: "probe", fileName: meta.displayName, buffer: buf, applyRtlFix: true });
    fragmented = needsAlternateExtraction(probe.blocks);
    if (fragmented) {
      console.log(`  ⚠ نص معطوب حتى بعد كل المسارات البديلة (extractionMethod=${probe.extractionMethod}) — استُبعد من الأدلة`);
      results.push({
        fileName: meta.displayName,
        sizeBytes: meta.size,
        fragmented: true,
        status: "fragmented",
        evidenceSufficiency: "insufficient",
        confidence: "low",
        evidenceCount: 0,
        sufficiencyEvidenceIds: [],
        evidence: [],
      });
      continue;
    }
  } catch (probeError) {
    // لا يمكن فحص التجزئة (فشل استخراج) — نكمل التحليل الطبيعي؛ خطأ الاستخراج سيظهر من النموذج.
    console.log(`  (تعذر فحص التجزئة: ${probeError.code ?? probeError.message})`);
  }

  try {
    const job = await runTrustedDocumentAnalysis({
      projectRoot,
      localStoredName,
      sha256: sha,
      originalFileName: meta.displayName,
      documentType: "pdf",
      env,
    });
    const report = job.report ?? job;
    results.push({
      fileName: meta.displayName,
      sizeBytes: meta.size,
      jobId: job.id,
      status: job.jobStatus,
      evidenceSufficiency: report.evidenceSufficiency,
      confidence: report.confidence,
      evidenceCount: (report.evidence || []).length,
      sufficiencyEvidenceIds: report.sufficiencyEvidenceIds || [],
      findings: report,
      evidence: report.evidence || [],
    });
    console.log(`  → كفاية الأدلة=${report.evidenceSufficiency} ثقة=${report.confidence} أدلة=${(report.evidence || []).length}`);
  } catch (error) {
    results.push({ fileName: meta.displayName, sizeBytes: meta.size, error: error.code || "FAILED", message: error.message?.slice(0, 200) });
    console.log(`  → فشل: ${error.code} — ${error.message?.slice(0, 150)}`);
  }
}

// دمج التقارير — المنطق في وحدة نقية مختبَرة معزولًا: analysis-multidoc-merge.mjs.
// ملاحظة صادقة (مُتحقَّق منها بمقارنة فعلية): المحتوى الناتج مطابق تمامًا للنسخة
// القديمة، لكن موضع مفتاحَي durationSecs/model في ملف JSON صار في نهاية الكائن
// بدل ما قبل coverageAssessment — فرق ترتيب مفاتيح تجميلي بلا أي أثر وظيفي
// (الملف تقرير يُعاد توليده كاملًا ولا يقارنه أي مستهلك).
const merged = mergeMultidocReports(results, { dominantThreshold: 0.8 });
merged.durationSecs = Math.round((Date.now() - t0) / 1000);
merged.model = "nemotron-3.5-lightning:latest";
if (merged.coverageWarning) console.log(`  ⚠ ${merged.coverageWarning}`);

const outPath = path.join(projectRoot, ".radar-data", "multidoc-report.json");
await writeFile(outPath, JSON.stringify(merged, null, 2));
console.log(`\n=== اكتمل في ${merged.durationSecs} ثانية ===`);
console.log("كفاية الأدلة الموحّدة:", merged.evidenceSufficiency, "| الثقة:", merged.confidence);
console.log("إجمالي الأدلة:", merged.totalEvidence);
console.log("أدلة الكفاية الموحّدة:", merged.sufficiencyEvidenceIds.length);
console.log("أخطاء:", merged.errors.length);
console.log(`حُفظ في ${outPath}`);
