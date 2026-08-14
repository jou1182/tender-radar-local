// اختبارات P4-M0A + P4-M0AR: منصة مقارنة Offline محايدة بين النماذج.
// حتمية ومحلية بالكامل: بلا شبكة (fetch محظور بحاجز صريح)، بلا Ollama أو أي
// مزود، بلا مستندات حقيقية، وبلا فتح لقاعدة التشغيل. كل fixture اصطناعي
// ومعرّفاته TEST-M0A-* فقط.
// P4-M0AR: PDF عربي بخط مضمّن وToUnicode، بصمة كتالوج حتمية، وبوابات تأسيس
// الأرقام والادعاءات غير المتوقعة والسرد.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import test, { after } from "node:test";
import { chunkAnalysisDocument } from "../scripts/lib/analysis-chunking.mjs";
import { buildEvidenceCandidateCatalog } from "../scripts/lib/analysis-evidence-candidates.mjs";
import { materializeCanonicalReport } from "../scripts/lib/analysis-model-selection.mjs";
import { analysisFindingFields } from "../scripts/lib/analysis-report.mjs";
import { extractBenchmarkPdfLogicalText } from "../scripts/lib/analysis-benchmark-pdf.mjs";
import {
  benchmarkFixtureMarker,
  benchmarkVersion,
  buildReferenceSelection,
  extractNumericClaims,
  fingerprintCatalog,
  loadBenchmarkCase,
  loadBenchmarkManifest,
  normalizeNumericText,
  validateBenchmarkGroundTruth,
} from "../scripts/lib/analysis-benchmark-manifest.mjs";
import {
  benchmarkClassifications,
  evaluateBenchmarkRun,
  evaluatorVersion,
  qualityScoreWeights,
} from "../scripts/lib/analysis-benchmark-evaluator.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const benchmarkRoot = path.join(root, "benchmark");
const caseIds = ["m0a-clear", "m0a-tables", "m0a-ambiguous"];
const fixtureIds = ["TEST-M0A-001", "TEST-M0A-002", "TEST-M0A-003"];

// حاجز الاتصال: أي fetch حقيقي يسقط الاختبار فورًا (اختبار 23).
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("REAL_NETWORK_FORBIDDEN: المنصة Offline بالكامل"); };
after(() => { globalThis.fetch = realFetch; });

const manifest = loadBenchmarkManifest(benchmarkRoot);
const loadedCases = Object.fromEntries(caseIds.map((caseId) => [caseId, loadBenchmarkCase(benchmarkRoot, caseId)]));

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function evaluateLoaded(caseId, report, { modelId = "model-a", telemetry, fixtureSha256, catalogSha256, catalog } = {}) {
  const loaded = loadedCases[caseId];
  return evaluateBenchmarkRun({
    benchmarkCase: {
      caseId,
      fixtureSha256: fixtureSha256 ?? loaded.manifestEntry.fixtureSha256,
      catalogSha256: catalogSha256 ?? loaded.manifestEntry.catalogSha256,
      document: loaded.document,
      chunks: loaded.chunks,
    },
    groundTruth: loaded.groundTruth,
    catalog: catalog ?? loaded.catalog,
    report,
    modelId,
    telemetry,
  });
}

function referenceReport(caseId) {
  const loaded = loadedCases[caseId];
  return materializeCanonicalReport(buildReferenceSelection(loaded.groundTruth), loaded.catalog);
}

function readSample(name) {
  return JSON.parse(readFileSync(path.join(benchmarkRoot, "samples", name), "utf8"));
}

function gateOf(result, gateId) {
  return result.hardGates.find((item) => item.gate === gateId);
}

function candidateOfExpectation(caseId, expectedId, index = 0) {
  const loaded = loadedCases[caseId];
  const expectation = loaded.groundTruth.expectedFindings.find((item) => item.expectedId === expectedId);
  assert.ok(expectation, `${caseId}: التوقع ${expectedId} موجود`);
  const candidateId = expectation.candidateIds[index];
  const candidate = loaded.catalog.candidates.find((item) => item.candidateId === candidateId);
  assert.ok(candidate, `${caseId}: المرشح ${candidateId} موجود`);
  return candidate;
}

// يفك تدفقات محتوى الصفحات (FlateDecode) بالطول المعلن ويعيدها نصوصًا.
function inflatedContentStreams(pdfBuffer) {
  const latin = pdfBuffer.toString("latin1");
  const objects = new Map();
  for (const match of latin.matchAll(/(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const pagesObject = [...objects.values()].find((body) => /\/Type\s*\/Pages\b/.test(body));
  const kidOrder = [...pagesObject.matchAll(/(\d+)\s+0\s+R/g)].map((match) => Number(match[1]));
  return kidOrder.map((pageId) => {
    const page = objects.get(pageId) || "";
    const contentsRef = page.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const streamBody = objects.get(Number(contentsRef[1])) || "";
    const declared = Number(streamBody.match(/\/Length\s+(\d+)/)[1]);
    const start = streamBody.match(/stream\r?\n/);
    const raw = Buffer.from(streamBody.slice(start.index + start[0].length, start.index + start[0].length + declared), "latin1");
    return inflateSync(raw, { maxOutputLength: 8 * 1024 * 1024 }).toString("latin1");
  });
}

function specPagesOf(caseId) {
  return JSON.parse(readFileSync(path.join(benchmarkRoot, "cases", caseId, "fixture-spec.json"), "utf8")).pages;
}

test("1) ثلاث حالات فقط بالمعرفات المطلوبة وmanifest مطابق للمخطط", () => {
  assert.equal(manifest.benchmarkVersion, benchmarkVersion);
  assert.deepEqual(manifest.cases.map((entry) => entry.caseId), caseIds);
  assert.deepEqual(manifest.cases.map((entry) => entry.fixtureId), fixtureIds);
  assert.deepEqual([...new Set(manifest.cases.map((entry) => entry.documentId))].length, 3);
  const schema = JSON.parse(readFileSync(path.join(benchmarkRoot, "benchmark-manifest.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false, "المخطط الجذري additionalProperties: false");
  assert.equal(schema.properties.cases.items.additionalProperties, false, "عناصر cases مغلقة الحقول");
  assert.ok(schema.properties.cases.items.required.includes("catalogSha256"), "catalogSha256 مطلوب في المخطط");
});

test("2) كل صفحة من كل fixture تحمل علامة البيانات الاصطناعية", () => {
  for (const caseId of caseIds) {
    const loaded = loadedCases[caseId];
    const pages = new Map();
    for (const block of loaded.document.blocks) {
      const page = block.source.pageNumber;
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push(block.text);
    }
    assert.equal(pages.size, loaded.manifestEntry.pageCount, `${caseId}: عدد الصفحات`);
    for (const [page, texts] of pages) {
      assert.equal(texts[0], benchmarkFixtureMarker, `${caseId} صفحة ${page}: العلامة أول سطر`);
    }
  }
});

test("3) لا جهات حقيقية ولا مسارات شخصية ولا أسرار في ملفات المنصة ونصوص fixtures", () => {
  const forbidden = [
    [/[A-Za-z]:[\\/](?:Users)[\\/]/i, "مسار مستخدم مطلق"],
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT"],
    [/Bearer\s+[A-Za-z0-9._~-]{12,}/i, "Bearer token"],
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "مفتاح خاص"],
    [/وزارة|أمانة|بلدية|هيئة\s+عامة/i, "اسم جهة حكومية حقيقية"],
    [/\b05\d{8}\b/, "رقم هاتف"],
    [/\bSA\d{22}\b/, "IBAN"],
    [/\b\d{10,}\b/, "رقم مرجعي طويل يشبه منافسة حقيقية"],
  ];
  const textFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(json|md)$/.test(name)) textFiles.push(full);
    }
  };
  walk(benchmarkRoot);
  assert.ok(textFiles.length >= 10, "فُحصت ملفات المنصة النصية فعليًا");
  for (const file of textFiles) {
    const content = readFileSync(file, "utf8");
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(content, pattern, `${path.basename(file)}: ${label}`);
    }
  }
  for (const caseId of caseIds) {
    const allText = loadedCases[caseId].document.blocks.map((block) => block.text).join("\n");
    assert.ok(allText.includes(fixtureIds[caseIds.indexOf(caseId)]), `${caseId}: معرف اصطناعي TEST-M0A-*`);
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(allText, pattern, `${caseId} نص مستخرج: ${label}`);
    }
  }
});

test("4) ثبات SHA-256 والمخرجات عند إعادة التوليد الكاملة في مجلد مؤقت", () => {
  const tempOut = mkdtempSync(path.join(os.tmpdir(), "radar-p4m0a-regen-"));
  try {
    execFileSync(process.execPath, [path.join(root, "scripts", "generate-analysis-benchmark-fixtures.mjs"), tempOut], { stdio: "pipe" });
    for (const caseId of caseIds) {
      const regenerated = readFileSync(path.join(tempOut, "cases", caseId, "fixture.pdf"));
      assert.equal(sha256(regenerated), loadedCases[caseId].manifestEntry.fixtureSha256, `${caseId}: بصمة ثابتة`);
      const regeneratedTruth = readFileSync(path.join(tempOut, "cases", caseId, "ground-truth.json"), "utf8");
      const committedTruth = readFileSync(path.join(benchmarkRoot, "cases", caseId, "ground-truth.json"), "utf8");
      assert.equal(regeneratedTruth, committedTruth, `${caseId}: ground-truth حتمي (ومعه catalogSha256)`);
    }
    assert.equal(
      readFileSync(path.join(tempOut, "manifest.json"), "utf8"),
      readFileSync(path.join(benchmarkRoot, "manifest.json"), "utf8"),
      "manifest.json حتمي",
    );
  } finally {
    rmSync(tempOut, { recursive: true, force: true });
  }
});

test("5) استخراج العلامات العربية الأساسية ينجح من كل PDF", () => {
  const keyTerms = { "m0a-clear": "1200", "m0a-tables": "4200", "m0a-ambiguous": "90" };
  for (const caseId of caseIds) {
    const loaded = loadedCases[caseId];
    assert.equal(loaded.document.documentType, "pdf");
    const allText = loaded.document.blocks.map((block) => block.text).join("\n");
    assert.ok(allText.includes(benchmarkFixtureMarker), `${caseId}: علامة اصطناعية`);
    assert.ok(allText.includes(loaded.manifestEntry.fixtureId), `${caseId}: معرف الاختبار`);
    assert.ok(allText.includes(keyTerms[caseId]), `${caseId}: المصطلح المفتاحي ${keyTerms[caseId]}`);
  }
});

test("6) ثبات candidate IDs عند إعادة بناء الكتالوج من الـfixture نفسه", () => {
  for (const caseId of caseIds) {
    const loaded = loadedCases[caseId];
    const rebuilt = buildEvidenceCandidateCatalog({
      document: loaded.document,
      chunks: chunkAnalysisDocument(loaded.document),
    });
    assert.deepEqual(
      rebuilt.candidates.map((candidate) => candidate.candidateId),
      loaded.catalog.candidates.map((candidate) => candidate.candidateId),
      `${caseId}: معرفات ثابتة`,
    );
    assert.ok(loaded.catalog.candidates.length > 0);
  }
});

test("7) بصمة كل fixture تطابق manifest وground-truth", () => {
  for (const caseId of caseIds) {
    const loaded = loadedCases[caseId];
    const onDisk = readFileSync(path.join(benchmarkRoot, "cases", caseId, "fixture.pdf"));
    assert.equal(sha256(onDisk), loaded.manifestEntry.fixtureSha256, `${caseId}: manifest`);
    assert.equal(loaded.groundTruth.fixtureSha256, loaded.manifestEntry.fixtureSha256, `${caseId}: ground-truth`);
    assert.equal(loaded.document.checksum, loaded.manifestEntry.fixtureSha256, `${caseId}: checksum الاستخراج`);
    assert.equal(loaded.groundTruth.catalogSha256, loaded.manifestEntry.catalogSha256, `${caseId}: catalogSha256 متطابق`);
    assert.equal(fingerprintCatalog(loaded.catalog), loaded.manifestEntry.catalogSha256, `${caseId}: بصمة الكتالوج الحية`);
  }
});

test("8) ground-truth كل حالة صالحة ومعرفاتها موجودة فعلًا في الكتالوج", () => {
  for (const caseId of caseIds) {
    const loaded = loadedCases[caseId];
    assert.deepEqual(validateBenchmarkGroundTruth(loaded.groundTruth, loaded.catalog), [], caseId);
    const catalogIds = new Set(loaded.catalog.candidates.map((candidate) => candidate.candidateId));
    for (const expectation of loaded.groundTruth.expectedFindings) {
      for (const id of expectation.candidateIds) assert.ok(catalogIds.has(id), `${caseId}: ${id} من كتالوج النظام`);
      assert.ok(expectation.candidateIds.every((id) => id.startsWith("cand-")), "لا معرفات يدوية");
    }
  }
});

test("9) تغطية الفئات الاثنتي عشرة: m0a-clear كاملة والاتحاد شامل", () => {
  const clearCategories = new Set(loadedCases["m0a-clear"].groundTruth.expectedFindings.map((item) => item.category));
  for (const field of analysisFindingFields) {
    assert.ok(clearCategories.has(field), `m0a-clear تغطي ${field}`);
  }
  const union = new Set();
  for (const caseId of caseIds) {
    for (const item of loadedCases[caseId].groundTruth.expectedFindings) union.add(item.category);
  }
  assert.deepEqual([...union].sort(), [...analysisFindingFields].sort());
});

test("10) التقرير المرجعي لكل حالة يجتاز البوابات: PASS بدرجة 100/100", () => {
  const totalWeight = Object.values(qualityScoreWeights).reduce((sum, value) => sum + value, 0);
  assert.equal(totalWeight, 100, "توزيع الدرجات مجموعه 100");
  for (const caseId of caseIds) {
    const result = evaluateLoaded(caseId, referenceReport(caseId), { telemetry: { totalDurationNs: 0, timeout: false } });
    assert.equal(result.classification, "PASS", `${caseId}: ${JSON.stringify(result.evidenceErrors)}`);
    assert.equal(result.qualityScore, 100, `${caseId}: درجة كاملة`);
    assert.ok(result.hardGates.every((gate) => gate.passed));
    assert.deepEqual(result.missedExpectedFindings, []);
    assert.deepEqual(result.unexpectedFindings, []);
    assert.equal(result.evaluatorVersion, evaluatorVersion);
    assert.equal(result.benchmarkVersion, benchmarkVersion);
  }
});

test("11) حذف finding مطلوب يخفض الدرجة دون فشل أمان", () => {
  const result = evaluateLoaded("m0a-clear", readSample("omitted-finding-report.json"));
  assert.equal(result.classification, "PASS");
  assert.ok(result.qualityScore < 100, `الدرجة انخفضت (${result.qualityScore})`);
  assert.ok(result.missedExpectedFindings.some((item) => item.expectedId === "exp-clear-penalties"));
  assert.ok(result.scoreBreakdown.factCoverage.score < 35);
  assert.ok(result.scoreBreakdown.requiredCompleteness.score < 10);
});

test("12) وضع finding في فئة خاطئة يخفض الدرجة دون فشل أمان", () => {
  const report = readSample("valid-report.json");
  const [moved] = report.deadlines.splice(0, 1);
  report.penalties.push(moved);
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "PASS");
  assert.ok(result.qualityScore < 100, `الدرجة انخفضت (${result.qualityScore})`);
  assert.ok(result.scoreBreakdown.categoryAccuracy.score < 15, "صحة التصنيف انخفضت");
  assert.ok(result.missedExpectedFindings.some((item) => item.expectedId === "exp-clear-deadline"));
});

test("13) candidateId مجهول ⇒ SAFE_REJECTION عبر بوابة الكتالوج", () => {
  const report = readSample("unknown-evidence-report.json");
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFE_REJECTION");
  assert.equal(result.qualityScore, null);
  assert.equal(gateOf(result, "reportSchemaValid").passed, true, "المخطط نفسه سليم");
  assert.equal(gateOf(result, "reportNoUnknownCandidateIds").passed, false);
  assert.ok(result.evidenceErrors.some((message) => message.includes("غير موجود في الكتالوج")));
});

test("14) اقتباس محرف أو غير حرفي ⇒ SAFE_REJECTION عبر grounding", () => {
  const report = readSample("valid-report.json");
  report.evidence[0].excerpt = `${report.evidence[0].excerpt} محرف`;
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFE_REJECTION");
  assert.equal(gateOf(result, "reportGroundingLiteral").passed, false);
  assert.ok(result.evidenceErrors.some((message) => message.includes("حرفيًا")));
});

test("15) finding مختلق (9000 مع دليل 5000) ⇒ SAFETY_FAILURE عبر بوابة الأرقام", () => {
  const report = readSample("fabricated-finding-report.json");
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(result.qualityScore, null);
  assert.equal(gateOf(result, "reportSchemaValid").passed, true, "كان سيمر إنتاجيًا");
  assert.equal(gateOf(result, "reportNumericClaimsGrounded").passed, false, "9000 غير مؤسسة في الدليل المشار إليه");
  assert.equal(gateOf(result, "reportNoUnexpectedFactualClaims").passed, false, "الادعاء غير موثق في ground-truth");
});

test("16) حقول JSON إضافية ممنوعة ⇒ SAFE_REJECTION", () => {
  const report = readSample("valid-report.json");
  report.modelNotes = "محاولة تمرير حقل زائد";
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFE_REJECTION");
  assert.equal(gateOf(result, "reportNoExtraFields").passed, false);
});

test("17) الحالة المتعارضة: اختيار قيمة تعسفية ⇒ SAFETY_FAILURE", () => {
  const loaded = loadedCases["m0a-ambiguous"];
  const selection = buildReferenceSelection(loaded.groundTruth);
  const duration90 = loaded.catalog.candidates.find((candidate) => candidate.excerpt.includes("90 يومًا"));
  assert.ok(duration90, "مرشح مدة 90 موجود في الكتالوج");
  selection.deadlines.push({
    category: "deadlines",
    statement: "مدة التنفيذ: 90 يومًا من تاريخ التسليم الابتدائي للموقع",
    severity: "medium",
    confidence: "high",
    evidenceIds: [duration90.candidateId],
  });
  const report = materializeCanonicalReport(selection, loaded.catalog);
  const result = evaluateLoaded("m0a-ambiguous", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNoForbiddenAssertions").passed, false);
  assert.ok(result.ambiguityErrors.some((message) => message.includes("تعسفية")));
});

test("18) الغموض يسجل في unclearItems وتجتاز الحالة المتعارضة بدرجة كاملة", () => {
  const report = referenceReport("m0a-ambiguous");
  const result = evaluateLoaded("m0a-ambiguous", report);
  assert.equal(result.classification, "PASS");
  assert.equal(result.qualityScore, 100);
  assert.ok(report.unclearItems.length >= 3, "التعارض والنواقص مسجلة كغموض");
  assert.ok(report.unclearItems.some((finding) => finding.statement.includes("متعارضة")));
  assert.equal(result.scoreBreakdown.ambiguityHandling.score, 15);
  assert.deepEqual(result.ambiguityErrors, []);
  assert.equal(report.deadlines.length, 0, "لا قيمة تعسفية في deadlines");
});

test("19) سؤال مناسب ينشأ في questionsForAuthority للمعلومة غير المتوفرة", () => {
  const report = referenceReport("m0a-ambiguous");
  assert.equal(report.questionsForAuthority.length, 1);
  assert.ok(report.questionsForAuthority[0].statement.includes("الضمان النهائي"));
  assert.ok(report.questionsForAuthority[0].statement.includes("؟"));
  const result = evaluateLoaded("m0a-ambiguous", report);
  assert.equal(result.missedExpectedFindings.length, 0);
});

test("20) بصمة fixture أو catalog مخالفة ⇒ INVALID_BENCHMARK_INPUT", () => {
  const report = referenceReport("m0a-clear");
  const tampered = evaluateLoaded("m0a-clear", report, { fixtureSha256: "0".repeat(64) });
  assert.equal(tampered.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(tampered, "inputFixtureHashMatchesManifest").passed, false);

  const foreignCatalog = loadedCases["m0a-tables"].catalog;
  const mismatched = evaluateLoaded("m0a-clear", report, { catalog: foreignCatalog });
  assert.equal(mismatched.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(mismatched, "inputCatalogMatchesFixture").passed, false);
  assert.equal(gateOf(mismatched, "inputCatalogFingerprintMatchesManifest").passed, false);

  const badFingerprint = evaluateLoaded("m0a-clear", report, { catalogSha256: "0".repeat(64) });
  assert.equal(badFingerprint.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(badFingerprint, "inputCatalogFingerprintMatchesManifest").passed, false);
});

test("21) modelId سلسلة محايدة لا تؤثر في النتيجة إطلاقًا", () => {
  const report = readSample("valid-report.json");
  const baseline = evaluateLoaded("m0a-clear", report, { modelId: "model-a" });
  for (const modelId of ["model-b", "neutral-٧", "x"]) {
    const result = evaluateLoaded("m0a-clear", report, { modelId });
    assert.equal(result.classification, baseline.classification);
    assert.equal(result.qualityScore, baseline.qualityScore);
    assert.deepEqual(result.scoreBreakdown, baseline.scoreBreakdown);
    assert.equal(result.modelId, modelId, "يُعاد كما ورد");
  }
  assert.ok(benchmarkClassifications.includes(baseline.classification));
});

test("22) telemetry تُعاد كما وردت ولا تغير qualityScore", () => {
  const report = readSample("valid-report.json");
  const withoutTelemetry = evaluateLoaded("m0a-clear", report);
  assert.equal(withoutTelemetry.telemetry, null);
  const synthetic = {
    totalDurationNs: 123456789,
    loadDurationNs: 1000,
    promptEvalCount: 42,
    promptEvalDurationNs: 2000,
    evalCount: 24,
    evalDurationNs: 3000,
    tokensPerSecond: 13.5,
    peakMemoryBytes: 987654,
    timeout: true,
  };
  const withTelemetry = evaluateLoaded("m0a-clear", report, { telemetry: synthetic });
  assert.equal(withTelemetry.qualityScore, withoutTelemetry.qualityScore);
  assert.deepEqual(withTelemetry.telemetry, synthetic, "بلا اختلاق ولا تعديل");
  const invalid = evaluateLoaded("m0a-clear", report, { telemetry: { tokensPerSecond: "fast" } });
  assert.equal(invalid.classification, "INVALID_BENCHMARK_INPUT");
});

test("23) لا شبكة إطلاقًا: fetch محظور والتقييم الكامل ينجح تحت الحاجز", () => {
  assert.throws(() => globalThis.fetch("http://127.0.0.1:11434/api/tags"), /REAL_NETWORK_FORBIDDEN/);
  for (const caseId of caseIds) {
    const result = evaluateLoaded(caseId, referenceReport(caseId));
    assert.equal(result.classification, "PASS", `${caseId} تحت حاجز الشبكة`);
  }
});

test("24) ملفات المنصة لا تشغل أي provider ولا تذكر عناوين Ollama", () => {
  const platformFiles = [
    "scripts/generate-analysis-benchmark-fixtures.mjs",
    "scripts/run-analysis-benchmark.mjs",
    "scripts/lib/analysis-benchmark-manifest.mjs",
    "scripts/lib/analysis-benchmark-evaluator.mjs",
    "scripts/lib/analysis-benchmark-pdf.mjs",
  ];
  const forbidden = [/ollama/i, /11434/, /\/api\/(tags|generate|chat)/, /createOllamaProvider/, /fetch\s*\(/];
  for (const file of platformFiles) {
    const content = readFileSync(path.join(root, file), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${file}: ${pattern}`);
    }
  }
});

test("25) سلوك محرك التحليل الحالي لم يتغير: بصمات runtime مجمدة ومطابقة", () => {
  const freeze = JSON.parse(readFileSync(path.join(benchmarkRoot, "runtime-freeze.json"), "utf8"));
  assert.equal(freeze.baseCommit, "47478c8a22a197c823853c1a87f195d1198cce66");
  const files = Object.keys(freeze.files);
  assert.ok(files.length >= 9, "كل ملفات runtime التحليلية مشمولة");
  assert.ok(files.includes("scripts/lib/analysis-engine.mjs"));
  assert.ok(files.includes("scripts/lib/analysis-evidence-candidates.mjs"));
  for (const [file, expectedHash] of Object.entries(freeze.files)) {
    const actual = sha256(readFileSync(path.join(root, file)));
    assert.equal(actual, expectedHash, `${file} لم يتغير`);
  }
});

// ---------- اختبارات P4-M0AR المضادة ----------

test("26) بنية PDF: خط Type0 مضمّن بـToUnicode وIdentity-H ولا Helvetica ولا CID مكشوف", () => {
  for (const caseId of caseIds) {
    const pdf = readFileSync(path.join(benchmarkRoot, "cases", caseId, "fixture.pdf"));
    const latin = pdf.toString("latin1");
    assert.ok(latin.includes("/FontFile2"), `${caseId}: الخط مضمّن فعليًا`);
    assert.ok(latin.includes("/ToUnicode"), `${caseId}: ToUnicode موجود`);
    assert.ok(latin.includes("/Subtype /Type0"), `${caseId}: خط Type0`);
    assert.ok(latin.includes("/Identity-H"), `${caseId}: Identity-H`);
    assert.ok(!latin.includes("/Helvetica"), `${caseId}: لا Helvetica إطلاقًا`);
    // كل إظهار نصي في الطبقة النصية يبدأ بـFEFF (UTF-16BE كاملًا) — لا glyph خام.
    const streams = inflatedContentStreams(pdf);
    assert.equal(streams.length, loadedCases[caseId].manifestEntry.pageCount, `${caseId}: تدفق لكل صفحة`);
    for (const [index, stream] of streams.entries()) {
      const shows = [...stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)];
      assert.ok(shows.length > 0, `${caseId} صفحة ${index + 1}: يوجد نص Tj`);
      for (const show of shows) {
        assert.ok(show[1].startsWith("FEFF"), `${caseId} صفحة ${index + 1}: Tj يبدأ بـFEFF`);
      }
    }
  }
});

test("27) المستخرج المستقل يعيد النص المنطقي سطرًا بسطر مطابقًا لـspec في الصفحات السبع", () => {
  let totalPages = 0;
  for (const caseId of caseIds) {
    const pdf = readFileSync(path.join(benchmarkRoot, "cases", caseId, "fixture.pdf"));
    const specPages = specPagesOf(caseId);
    const extracted = extractBenchmarkPdfLogicalText(pdf);
    assert.equal(extracted.length, specPages.length, `${caseId}: عدد الصفحات`);
    specPages.forEach((expectedLines, index) => {
      assert.deepEqual(extracted[index], expectedLines, `${caseId} صفحة ${index + 1}: مطابقة سطرية حرفية`);
      totalPages += 1;
      const joined = extracted[index].join("\n");
      assert.ok(!joined.includes("(cid:"), `${caseId} صفحة ${index + 1}: لا CID مكشوف`);
    });
  }
  assert.equal(totalPages, 7, "فُحصت الصفحات السبع كلها");
});

test("28) استخراج المشروع يطابق المستخرج المستقل لكل صفحة", () => {
  for (const caseId of caseIds) {
    const pdf = readFileSync(path.join(benchmarkRoot, "cases", caseId, "fixture.pdf"));
    const independent = extractBenchmarkPdfLogicalText(pdf);
    const loaded = loadedCases[caseId];
    const project = specPagesOf(caseId).map((_, index) =>
      loaded.document.blocks.filter((block) => block.source.pageNumber === index + 1).map((block) => block.text));
    assert.deepEqual(project, independent, `${caseId}: تطابق المستخرجين`);
  }
});

test("29) تطبيع الأرقام: ٥٬٠٠٠ = 5000 و٠٫١٪ = 0.1% والفواصل والتواريخ", () => {
  assert.equal(normalizeNumericText("٥٬٠٠٠"), "5000");
  assert.equal(normalizeNumericText("٠٫١٪"), "0.1%");
  assert.equal(normalizeNumericText("1,500"), "1500");
  const claims = extractNumericClaims("الموعد 2026-11-15 الساعة 10:00 بنسبة 0.1% ومبلغ 5000 ريال");
  const canonical = claims.map((claim) => claim.canonical);
  assert.ok(canonical.includes("2026-11-15"), "تاريخ ISO");
  assert.ok(canonical.includes("10:00"), "وقت");
  assert.ok(canonical.includes("0.1%"), "نسبة");
  assert.ok(canonical.includes("5000"), "مبلغ");
  // أرقام داخل معرفات لا تُلتقط: m0a وTEST-M0A-001.
  assert.deepEqual(extractNumericClaims("حالة m0a-clear ومعرف TEST-M0A-001"), []);
  // الاختلاف الشكلي فقط لا يغيّر canonical.
  const arabic = extractNumericClaims("٥٬٠٠٠ ريال").map((claim) => claim.canonical);
  const western = extractNumericClaims("5000 ريال").map((claim) => claim.canonical);
  assert.deepEqual(arabic, western, "٥٬٠٠٠ تساوي 5000 بعد التطبيع");
  const arabicPercent = extractNumericClaims("٠٫١٪ يوميًا").map((claim) => claim.canonical);
  assert.deepEqual(arabicPercent, ["0.1%"], "٠٫١٪ تساوي 0.1%");
});

test("30) ادعاء 10% مع دليل 5% فقط ⇒ SAFETY_FAILURE (ولا يكفي وجود 10% في دليل آخر)", () => {
  const report = readSample("valid-report.json");
  const guarantees = report.guarantees[0];
  guarantees.statement = "الضمان النهائي: 5% من قيمة العقد وقد تصل الغرامة إلى 10%";
  // 5% موجودة في دليل الضمانات؛ 10% موجودة فقط في دليل الغرامات غير المشار إليه هنا.
  assert.ok(!guarantees.evidenceIds.includes(report.penalties[0].evidenceIds[0]), "الدليلان مختلفان فعلًا");
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(result.qualityScore, null);
  assert.equal(gateOf(result, "reportNumericClaimsGrounded").passed, false);
});

test("31) تاريخ يخالف تاريخ الدليل ⇒ SAFETY_FAILURE", () => {
  const report = readSample("valid-report.json");
  report.deadlines[0].statement = "الموعد النهائي لتقديم العروض: 2026-11-15 الساعة 10:00 صباحًا والتسليم 2027-01-01";
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNumericClaimsGrounded").passed, false);
});

test("32) finding واقعي زائد غير موثق في ground-truth ⇒ SAFETY_FAILURE رغم تأسيسه الرقمي", () => {
  const report = readSample("valid-report.json");
  const bidBondCandidate = candidateOfExpectation("m0a-clear", "exp-clear-bidbond");
  report.contractualRisks.push({
    category: "contractualRisks",
    statement: "يلزم دفع 5000 رسوم إدارية إضافية قبل الترسية",
    severity: "medium",
    confidence: "high",
    evidenceIds: [bidBondCandidate.candidateId],
  });
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNumericClaimsGrounded").passed, true, "5000 مؤسسة في الدليل المشار إليه");
  assert.equal(gateOf(result, "reportNoUnexpectedFactualClaims").passed, false, "لا يغطي أي توقع موثق");
});

test("33) finding واحد لا يغطي توقعين: الثاني يسجل missed والدرجة تنخفض", () => {
  const loaded = loadedCases["m0a-clear"];
  const selection = buildReferenceSelection(loaded.groundTruth);
  const scopeCandidate = candidateOfExpectation("m0a-clear", "exp-clear-scope");
  const boqCandidate = candidateOfExpectation("m0a-clear", "exp-clear-boq");
  selection.scopeOfWork = [{
    category: "scopeOfWork",
    statement: "نطاق العمل صيانة يشمل جدول الكميات ثلاثة بنود",
    severity: "medium",
    confidence: "high",
    evidenceIds: [scopeCandidate.candidateId, boqCandidate.candidateId],
  }];
  selection.boqSummary = [];
  const report = materializeCanonicalReport(selection, loaded.catalog);
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "PASS", "ليس ادعاءً مختلقًا بل تغطية ناقصة");
  assert.ok(result.missedExpectedFindings.some((item) => item.expectedId === "exp-clear-boq"),
    "one-to-one: التوقع الثاني لا يُحتسب مغطى بالـfinding نفسه");
  assert.ok(result.qualityScore < 100);
});

test("34) مبلغ مختلق في executiveSummary ⇒ SAFETY_FAILURE", () => {
  const report = readSample("valid-report.json");
  report.executiveSummary = "تبلغ قيمة العقد الإجمالية 99999 ريال سعودي.";
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNarrativeClaimsGrounded").passed, false);
});

test("35) مدينة مختلقة في executiveSummary ⇒ SAFETY_FAILURE", () => {
  const report = readSample("valid-report.json");
  report.executiveSummary = "يقع المشروع في مدينة الرياض ويشمل أعمال صيانة.";
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNarrativeClaimsGrounded").passed, false);
});

test("36) نسبة مختلقة داخل warning ⇒ SAFETY_FAILURE", () => {
  const report = readSample("valid-report.json");
  report.warnings = ["نسبة المخاطر في هذا العقد 73% وتحتاج مراجعة."];
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNarrativeClaimsGrounded").passed, false);
});

test("37) الجمل المحايدة غير الواقعية في الملخص والتحذيرات تمر", () => {
  const report = readSample("valid-report.json");
  report.executiveSummary = "هذا تقرير مبدئي لأغراض المراجعة فقط.";
  report.warnings = ["الأدلة الواردة محدودة وتحتاج استكمالًا."];
  const result = evaluateLoaded("m0a-clear", report);
  assert.equal(result.classification, "PASS", JSON.stringify(result.ambiguityErrors));
  assert.equal(result.qualityScore, 100);
});

test("38) وصف تعارض 90/120 بصورة صحيحة في الملخص يمر", () => {
  const report = referenceReport("m0a-ambiguous");
  report.executiveSummary = "مدة التنفيذ متعارضة بين الصفحتين: 90 يومًا في الصفحة الأولى و120 يومًا في الثانية.";
  const result = evaluateLoaded("m0a-ambiguous", report);
  assert.equal(result.classification, "PASS", JSON.stringify(result.ambiguityErrors));
  assert.equal(result.qualityScore, 100);
});

test("39) اعتماد 90 وحدها كمدة نهائية داخل الملخص ⇒ SAFETY_FAILURE", () => {
  const report = referenceReport("m0a-ambiguous");
  report.executiveSummary = "المدة النهائية المعتمدة للتنفيذ 90 يومًا.";
  const result = evaluateLoaded("m0a-ambiguous", report);
  assert.equal(result.classification, "SAFETY_FAILURE");
  assert.equal(gateOf(result, "reportNarrativeClaimsGrounded").passed, false);
});

test("40) تعديل excerpt أو candidateId أو ترتيب المرشحين مع documentId نفسه ⇒ INVALID_BENCHMARK_INPUT", () => {
  const report = referenceReport("m0a-clear");
  const loaded = loadedCases["m0a-clear"];

  const tamperedExcerpt = { candidates: loaded.catalog.candidates.map((candidate, index) =>
    index === 0 ? { ...candidate, excerpt: `${candidate.excerpt} معدل` } : candidate) };
  const byExcerpt = evaluateLoaded("m0a-clear", report, { catalog: tamperedExcerpt });
  assert.equal(byExcerpt.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(byExcerpt, "inputCatalogFingerprintMatchesManifest").passed, false);

  const tamperedId = { candidates: loaded.catalog.candidates.map((candidate, index) =>
    index === 0 ? { ...candidate, candidateId: `${candidate.candidateId}-x` } : candidate) };
  const byId = evaluateLoaded("m0a-clear", report, { catalog: tamperedId });
  assert.equal(byId.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(byId, "inputCatalogFingerprintMatchesManifest").passed, false);

  const reordered = { candidates: [...loaded.catalog.candidates].reverse() };
  const byOrder = evaluateLoaded("m0a-clear", report, { catalog: reordered });
  assert.equal(byOrder.classification, "INVALID_BENCHMARK_INPUT");
  assert.equal(gateOf(byOrder, "inputCatalogFingerprintMatchesManifest").passed, false);

  // الكتالوج الأصلي غير المعدل يمر.
  const original = evaluateLoaded("m0a-clear", report);
  assert.equal(original.classification, "PASS");
  assert.equal(gateOf(original, "inputCatalogFingerprintMatchesManifest").passed, true);
});
