// P5-MULTIDOC: تحليل حي للملفات الأربعة لمنافسة واحدة، ثم دمج التقارير.
// كل مستند يُحلَّل عبر المسار الأحادي المعتمد (سياق كامل)، ثم تُدمج النتائج
// في تقرير موحّد. الدمج على مستوى التقرير — لا على مستوى كتالوج مشوّه.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRadarRepository } from "./radar-repository.mjs";
import { runTrustedDocumentAnalysis } from "./trusted-document-cli.mjs";
import { extractAnalysisDocument } from "./analysis-documents.mjs";
import { isFragmentedDocument, assessCoverageBalance, coverageWarningMessage } from "./analysis-quality-gates.mjs";

const TENDER = "260839003247";
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

  // P5-QGATE: فحص التجزئة قبل استدعاء النموذج — ملف مجزأ يُستبعد من الأدلة.
  let fragmented = false;
  try {
    const probe = extractAnalysisDocument({ documentId: "probe", fileName: meta.displayName, buffer: buf, applyRtlFix: true });
    fragmented = isFragmentedDocument(probe.blocks, { ratio: 0.9 });
    if (fragmented) {
      console.log(`  ⚠ نص مجزأ (${Math.round((probe.blocks.filter((b) => b.text.trim().length <= 2).length / probe.blocks.length) * 100)}% كتل مفردة) — استُبعد من الأدلة`);
      results.push({
        fileName: meta.displayName,
        sizeBytes: meta.size,
        fragmented: true,
        status: "fragmented",
        decision: "insufficient_data",
        confidence: "low",
        evidenceCount: 0,
        decisionEvidenceIds: [],
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
      decision: report.preliminaryDecision,
      confidence: report.confidence,
      evidenceCount: (report.evidence || []).length,
      decisionEvidenceIds: report.decisionEvidenceIds || [],
      findings: report,
      evidence: report.evidence || [],
    });
    console.log(`  → قرار=${report.preliminaryDecision} ثقة=${report.confidence} أدلة=${(report.evidence || []).length}`);
  } catch (error) {
    results.push({ fileName: meta.displayName, sizeBytes: meta.size, error: error.code || "FAILED", message: error.message?.slice(0, 200) });
    console.log(`  → فشل: ${error.code} — ${error.message?.slice(0, 150)}`);
  }
}

// دمج التقارير
const decisionRank = { enter: 3, review: 2, exclude: 1, insufficient_data: 0 };
const confidenceRank = { high: 3, medium: 2, low: 1 };
const merged = {
  preliminaryDecision: "insufficient_data",
  confidence: "low",
  decisionEvidenceIds: [],
  files: results.map((r) => ({ fileName: r.fileName, sizeBytes: r.sizeBytes, decision: r.decision, confidence: r.confidence, evidenceCount: r.evidenceCount, error: r.error })),
  perFileEvidence: {},
  errors: results.filter((r) => r.error).map((r) => ({ fileName: r.fileName, code: r.error, message: r.message })),
};
const decisionFileMap = {};
for (const r of results) {
  if (r.error) continue;
  const dr = decisionRank[r.decision] ?? 0;
  if (dr > (decisionRank[merged.preliminaryDecision] ?? 0)) {
    merged.preliminaryDecision = r.decision;
    merged.confidence = r.confidence;
  } else if (dr === (decisionRank[merged.preliminaryDecision] ?? 0)) {
    if ((confidenceRank[r.confidence] ?? 0) > (confidenceRank[merged.confidence] ?? 0)) merged.confidence = r.confidence;
  }
  for (const id of r.decisionEvidenceIds) {
    if (!merged.decisionEvidenceIds.includes(id)) {
      merged.decisionEvidenceIds.push(id);
      decisionFileMap[id] = r.fileName;
    }
  }
  merged.perFileEvidence[r.fileName] = r.evidence.map((e) => ({ evidenceId: e.evidenceId, pageNumber: e.pageNumber, excerpt: e.excerpt }));
}
merged.totalEvidence = results.reduce((s, r) => s + (r.evidenceCount || 0), 0);
merged.decisionEvidenceFileMap = decisionFileMap;
merged.durationSecs = Math.round((Date.now() - t0) / 1000);
merged.model = "nemotron-3.5-lightning:latest";

// P5-QGATE: فحص هيمنة ملف واحد بعد الدمج — إن كانت التغطية غير متوازنة،
// اخفض الثقة إلى low واعرض رسالة صريحة بدل قرار واثق مضلل.
const perFileCounts = {};
for (const r of results) perFileCounts[r.fileName] = r.evidenceCount || 0;
const coverage = assessCoverageBalance(perFileCounts, { dominantThreshold: 0.8 });
merged.coverageAssessment = coverage;
if (coverage.unbalanced) {
  merged.confidence = "low";
  merged.coverageWarning = coverageWarningMessage(coverage);
  console.log(`  ⚠ ${merged.coverageWarning}`);
}

const outPath = path.join(projectRoot, ".radar-data", "multidoc-report.json");
await writeFile(outPath, JSON.stringify(merged, null, 2));
console.log(`\n=== اكتمل في ${merged.durationSecs} ثانية ===`);
console.log("القرار الموحّد:", merged.preliminaryDecision, "| الثقة:", merged.confidence);
console.log("إجمالي الأدلة:", merged.totalEvidence);
console.log("أدلة القرار الموحّد:", merged.decisionEvidenceIds.length);
console.log("أخطاء:", merged.errors.length);
console.log(`حُفظ في ${outPath}`);
