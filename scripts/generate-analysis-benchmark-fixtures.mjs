// مولد fixtures منصة المقارنة Offline — P4-M0A / P4-M0AR.
// يقرأ fixture-spec.json المؤلفة يدويًا لكل حالة، وينتج حتميًا: fixture.pdf
// عبر باني benchmark الخاص (analysis-benchmark-pdf.mjs): خط عربي مضمن +
// ToUnicode + ترتيب RTL — بلا metadata ولا تواريخ، وground-truth.json
// بمعرفات مرشحين محلولة من كتالوج النظام الفعلي (لا معرفات يدوية)، وmanifest.json
// ببصمات SHA-256 للـfixture والكتالوج، وعينات تقارير الاختبار، وملف تجميد سلامة runtime.
// الاستخدام: node scripts/generate-analysis-benchmark-fixtures.mjs [outRoot]
// outRoot الافتراضي: benchmark/ داخل المستودع. لا شبكة ولا نماذج إطلاقًا.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchmarkPdf } from "./lib/analysis-benchmark-pdf.mjs";
import { extractAnalysisDocument } from "./lib/analysis-documents.mjs";
import { chunkAnalysisDocument } from "./lib/analysis-chunking.mjs";
import { buildEvidenceCandidateCatalog } from "./lib/analysis-evidence-candidates.mjs";
import {
  assertValidBenchmarkManifest,
  benchmarkFixtureMarker,
  benchmarkFixtureSpecVersion,
  benchmarkGroundTruthVersion,
  benchmarkVersion,
  buildReferenceSelection,
  fingerprintCatalog,
  loadBenchmarkCase,
  materializeReferenceReport,
  resolveExpectationCandidateIds,
  validateBenchmarkGroundTruth,
} from "./lib/analysis-benchmark-manifest.mjs";
import { evaluateBenchmarkRun } from "./lib/analysis-benchmark-evaluator.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceBenchmarkRoot = path.join(repoRoot, "benchmark");
const outRoot = path.resolve(process.argv[2] || sourceBenchmarkRoot);
// خط المنصة المضمن في كل fixture: DejaVu Sans مقلَّص محليًا (انظر benchmark/assets/fonts/FONT-SOURCE.md).
const benchmarkFontPath = path.join(sourceBenchmarkRoot, "assets", "fonts", "dejavu-sans-arabic-subset.ttf");

export const benchmarkCaseIds = ["m0a-clear", "m0a-tables", "m0a-ambiguous"];

// ملفات runtime المحلية التي يمنع على هذه المرحلة تعديلها — تُجمّد بصماتها.
const runtimeFreezeFiles = [
  "scripts/lib/analysis-api.mjs",
  "scripts/lib/analysis-chunking.mjs",
  "scripts/lib/analysis-documents.mjs",
  "scripts/lib/analysis-engine.mjs",
  "scripts/lib/analysis-evidence-candidates.mjs",
  "scripts/lib/analysis-fixtures.mjs",
  "scripts/lib/analysis-model-selection.mjs",
  "scripts/lib/analysis-providers.mjs",
  "scripts/lib/analysis-report.mjs",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function specError(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_SPEC_INVALID";
  return error;
}

function validateSpec(spec, caseId) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw specError(`spec ${caseId}: ليس كائنًا.`);
  if (spec.specVersion !== benchmarkFixtureSpecVersion) throw specError(`spec ${caseId}: specVersion غير صالحة.`);
  if (spec.caseId !== caseId) throw specError(`spec ${caseId}: caseId لا يطابق اسم المجلد.`);
  if (!/^TEST-M0A-\d{3}$/.test(spec.fixtureId || "")) throw specError(`spec ${caseId}: fixtureId غير صالح.`);
  if (!spec.documentId) throw specError(`spec ${caseId}: documentId مفقود.`);
  if (!Array.isArray(spec.pages) || !spec.pages.length) throw specError(`spec ${caseId}: pages فارغة.`);
  spec.pages.forEach((page, index) => {
    if (!Array.isArray(page) || !page.length) throw specError(`spec ${caseId}: الصفحة ${index + 1} فارغة.`);
    if (page[0] !== benchmarkFixtureMarker) {
      throw specError(`spec ${caseId}: الصفحة ${index + 1} لا تبدأ بعلامة البيانات الاصطناعية الإلزامية.`);
    }
  });
  if (!Array.isArray(spec.expectedFindings) || !spec.expectedFindings.length) {
    throw specError(`spec ${caseId}: expectedFindings فارغة.`);
  }
  if (!Array.isArray(spec.forbiddenAssertions)) throw specError(`spec ${caseId}: forbiddenAssertions مفقودة.`);
}

function buildCase(caseId) {
  const caseDir = path.join(sourceBenchmarkRoot, "cases", caseId);
  const spec = JSON.parse(readFileSync(path.join(caseDir, "fixture-spec.json"), "utf8"));
  validateSpec(spec, caseId);

  const pdfBuffer = buildBenchmarkPdf(spec.pages, readFileSync(benchmarkFontPath));
  const fixtureSha256 = sha256(pdfBuffer);
  const document = extractAnalysisDocument({
    documentId: spec.documentId,
    fileName: "fixture.pdf",
    buffer: pdfBuffer,
    applyRtlFix: false,
  });
  const chunks = chunkAnalysisDocument(document);
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const catalogSha256 = fingerprintCatalog(catalog);

  // حل معرفات المرشحين من المقتطفات الموثقة — من كتالوج النظام فقط.
  const expectedFindings = spec.expectedFindings.map((expectation) => ({
    expectedId: expectation.expectedId,
    category: expectation.category,
    expectedValue: expectation.expectedValue,
    required: expectation.required,
    criticalTerms: expectation.criticalTerms,
    availability: expectation.availability,
    candidateIds: resolveExpectationCandidateIds(expectation, catalog),
    ...(expectation.expectedPageNumber !== undefined ? { expectedPageNumber: expectation.expectedPageNumber } : {}),
  }));
  const groundTruth = {
    groundTruthVersion: benchmarkGroundTruthVersion,
    caseId: spec.caseId,
    fixtureId: spec.fixtureId,
    documentId: spec.documentId,
    fixtureSha256,
    catalogSha256,
    expectedFindings,
    forbiddenAssertions: spec.forbiddenAssertions,
  };
  const groundTruthErrors = validateBenchmarkGroundTruth(groundTruth, catalog);
  if (groundTruthErrors.length) throw specError(`ground-truth ${caseId} غير صالح: ${groundTruthErrors[0]}`);

  return { spec, pdfBuffer, fixtureSha256, catalogSha256, document, chunks, catalog, groundTruth, pageCount: spec.pages.length };
}

function buildSamples(clearCase) {
  const { catalog, groundTruth } = clearCase;
  const selection = buildReferenceSelection(groundTruth);
  const validReport = materializeReferenceReport(selection, catalog);

  // عينة الحذف: إسقاط finding الغرامات المطلوب دون أي خلل بنيوي.
  const omittedSelection = {
    ...selection,
    penalties: [],
  };
  const omittedReport = materializeReferenceReport(omittedSelection, catalog);

  // عينة الدليل المجهول: finding يشير إلى معرف ليس في الكتالوج (النظام كان سيرفضه).
  // تُضاف نسخة دليل بالمعرف المجهول مع إبقاء الدليل الأصلي كي يبقى التقرير
  // مطابقًا للمخطط — فيكون الرفض حصرًا عبر بوابة candidateId المجهول.
  const unknownId = "cand-deadbeefdeadbeefdeadbeef";
  const scopeCandidate = catalog.candidates.find((candidate) => candidate.candidateId === groundTruth.expectedFindings[0].candidateIds[0]);
  const unknownReport = JSON.parse(JSON.stringify(validReport));
  unknownReport.scopeOfWork[0].evidenceIds = [unknownId];
  const scopeEvidence = unknownReport.evidence.find((item) => item.evidenceId === scopeCandidate.candidateId);
  unknownReport.evidence.push({ ...scopeEvidence, evidenceId: unknownId });

  // عينة الـfinding المختلق: ادعاء ضمان ابتدائي بقيمة غير موجودة مستندًا إلى دليل نطاق العمل.
  const fabricatedReport = JSON.parse(JSON.stringify(validReport));
  fabricatedReport.bidBonds.push({
    category: "bidBonds",
    statement: "الضمان الابتدائي المطلوب 9000 ريال سعودي",
    severity: "medium",
    confidence: "high",
    evidenceIds: [scopeCandidate.candidateId],
  });

  return { validReport, omittedReport, unknownReport, fabricatedReport };
}

function main() {
  const builtCases = benchmarkCaseIds.map(buildCase);
  const totalPdfBytes = builtCases.reduce((sum, item) => sum + item.pdfBuffer.length, 0);
  if (totalPdfBytes > 1024 * 1024) {
    throw specError(`الحجم الإجمالي للـPDFs (${totalPdfBytes}) يتجاوز 1MB — يلزم مبرر موثق.`);
  }

  const manifest = {
    benchmarkVersion,
    generatedBy: "scripts/generate-analysis-benchmark-fixtures.mjs",
    cases: builtCases.map(({ spec, fixtureSha256, catalogSha256, pageCount }) => ({
      caseId: spec.caseId,
      fixtureId: spec.fixtureId,
      documentId: spec.documentId,
      title: spec.title,
      fixtureFile: `cases/${spec.caseId}/fixture.pdf`,
      fixtureSha256,
      catalogSha256,
      pageCount,
      specFile: `cases/${spec.caseId}/fixture-spec.json`,
      groundTruthFile: `cases/${spec.caseId}/ground-truth.json`,
    })),
  };
  assertValidBenchmarkManifest(manifest);

  for (const built of builtCases) {
    const caseOutDir = path.join(outRoot, "cases", built.spec.caseId);
    mkdirSync(caseOutDir, { recursive: true });
    writeFileSync(path.join(caseOutDir, "fixture.pdf"), built.pdfBuffer);
    writeJson(path.join(caseOutDir, "ground-truth.json"), built.groundTruth);
    // النسخة المرجعية من spec تبقى مؤلفة يدويًا في المصدر؛ تُنسخ عند اختلاف الجذر فقط.
    if (outRoot !== sourceBenchmarkRoot) {
      writeJson(path.join(caseOutDir, "fixture-spec.json"), built.spec);
    }
  }
  writeJson(path.join(outRoot, "manifest.json"), manifest);

  const samples = buildSamples(builtCases[0]);
  const samplesDir = path.join(outRoot, "samples");
  mkdirSync(samplesDir, { recursive: true });
  writeJson(path.join(samplesDir, "valid-report.json"), samples.validReport);
  writeJson(path.join(samplesDir, "omitted-finding-report.json"), samples.omittedReport);
  writeJson(path.join(samplesDir, "unknown-evidence-report.json"), samples.unknownReport);
  writeJson(path.join(samplesDir, "fabricated-finding-report.json"), samples.fabricatedReport);

  const runtimeFreeze = {
    frozenAtPhase: "P4-M0A",
    baseCommit: "47478c8a22a197c823853c1a87f195d1198cce66",
    files: Object.fromEntries(
      runtimeFreezeFiles.map((file) => [file, sha256(readFileSync(path.join(repoRoot, file)))]),
    ),
  };
  writeJson(path.join(outRoot, "runtime-freeze.json"), runtimeFreeze);

  // تحقق ذاتي Offline: التقرير المرجعي يجب أن يجتاز البوابات بدرجة كاملة لكل حالة.
  const selfCheck = [];
  for (const built of builtCases) {
    const loaded = loadBenchmarkCase(outRoot, built.spec.caseId);
    const referenceReport = materializeReferenceReport(buildReferenceSelection(loaded.groundTruth), loaded.catalog);
    const result = evaluateBenchmarkRun({
      benchmarkCase: {
        caseId: built.spec.caseId,
        fixtureSha256: loaded.manifestEntry.fixtureSha256,
        catalogSha256: loaded.manifestEntry.catalogSha256,
        document: loaded.document,
        chunks: loaded.chunks,
      },
      groundTruth: loaded.groundTruth,
      catalog: loaded.catalog,
      report: referenceReport,
      modelId: "model-a",
      telemetry: { totalDurationNs: 0, tokensPerSecond: 0, timeout: false },
    });
    selfCheck.push({
      caseId: built.spec.caseId,
      classification: result.classification,
      qualityScore: result.qualityScore,
      candidates: loaded.catalog.candidates.length,
      fixtureSha256: built.fixtureSha256,
      sizeBytes: built.pdfBuffer.length,
    });
    if (result.classification !== "PASS" || result.qualityScore !== 100) {
      throw specError(`التحقق الذاتي فشل للحالة ${built.spec.caseId}: ${result.classification} / ${result.qualityScore}`);
    }
  }

  console.log(JSON.stringify({ ok: true, outRoot, totalPdfBytes, selfCheck }, null, 2));
}

main();
