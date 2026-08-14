// اختبارات P4-A1R: تقوية مدقق تقارير التحليل ضد مخرجات الذكاء الاصطناعي المشوهة.
// المدقق دالة كلية على أي قيمة JSON — لا TypeError إطلاقًا — والمخرجات المشوهة
// تنتهي بـAI_OUTPUT_INVALID دون حفظ تقرير أو findings أو evidence وبلا إعادة محاولة.
// fixtures ومحاكاة محلية فقط: بلا شبكة، بلا Ollama حي، بلا Chrome أو اعتماد.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import {
  analysisFindingFields,
  analysisPromptVersion,
  analysisReportSchemaVersion,
  emptyAnalysisReport,
  normalizeReportEvidenceIds,
  validateAnalysisReport,
} from "../scripts/lib/analysis-report.mjs";
import { createOllamaProvider } from "../scripts/lib/analysis-providers.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));
const ollamaEnv = { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" };

// حاجز الشبكة: أي محاولة للوصول إلى fetch الحقيقي تسقط الاختبار فورًا.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("REAL_NETWORK_FORBIDDEN: استخدم fetchFn وهميًا"); };
after(() => { globalThis.fetch = realFetch; });

// عداد حالات المدخلات المشوهة المختبرة — حتمي وقابل للتكرار (جداول ثابتة).
let malformedCases = 0;

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4a1r-"));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

async function cleanup(projectRoot, repository) {
  repository?.close();
  await rm(projectRoot, { recursive: true, force: true });
}

// لا يرمي المدقق أبدًا، ويعيد أخطاء غير فارغة، ويرفض التقرير.
function expectRejection(value, context) {
  malformedCases += 1;
  let errors = null;
  assert.doesNotThrow(() => { errors = validateAnalysisReport(value); }, `${context}: لا TypeError`);
  assert.ok(Array.isArray(errors) && errors.length > 0, `${context}: أخطاء تحقق غير فارغة — التقرير مرفوض`);
  return errors;
}

const validEvidenceItem = { evidenceId: "ev-1", documentId: "doc-v", sourceType: "pdf", pageNumber: 1, excerpt: "نص مقتطف", chunkId: "chk-1" };

function validFinding(evidenceIds = ["ev-1"]) {
  return { category: "scopeOfWork", statement: "بند نطاق عمل", severity: "info", confidence: "medium", evidenceIds };
}

test("A) المدقق دالة كلية على التقرير كاملًا: null ونص وعدد ومنطقية ومصفوفة وكائن ناقص", () => {
  const wholeReportCases = [null, "نص", 42, true, ["مصفوفة"], {}];
  for (const value of wholeReportCases) {
    expectRejection(value, `التقرير=${JSON.stringify(value)}`);
  }
  // تقرير ينقصه حقل أو أكثر: يذكر الخطأ اسم كل حقل مفقود.
  for (const field of ["executiveSummary", "evidence", "decisionEvidenceIds"]) {
    const partial = emptyAnalysisReport();
    delete partial[field];
    const errors = expectRejection(partial, `حقل مفقود: ${field}`);
    assert.ok(errors.some((line) => line.includes(field)), `الخطأ يذكر الحقل المفقود ${field}`);
  }
});

test("B) كل فئات findings الاثنتي عشرة × القيم المشوهة الخمس", () => {
  assert.equal(analysisFindingFields.length, 12, "الفئات اثنتا عشرة");
  const malformedValues = [null, {}, "text", 1, true];
  for (const field of analysisFindingFields) {
    for (const value of malformedValues) {
      const report = { ...emptyAnalysisReport(), [field]: value };
      const errors = expectRejection(report, `${field}=${JSON.stringify(value)}`);
      assert.ok(errors.some((line) => line.includes(field)), `الخطأ يذكر اسم الحقل ${field}`);
    }
  }
});

test("C) عناصر findings المشوهة داخل مصفوفة صحيحة الشكل", () => {
  const base = () => ({ ...emptyAnalysisReport(), evidence: [validEvidenceItem] });
  const elementCases = [
    [null, "ليس كائنًا"],
    ["نص", "ليس كائنًا"],
    [5, "ليس كائنًا"],
    [{}, "category مفقودة"],
    [{ category: "scopeOfWork" }, "statement مفقود"],
    [{ ...validFinding(), severity: "extreme" }, "severity غير صالحة"],
    [{ ...validFinding(), confidence: "sure" }, "confidence غير صالحة"],
    [{ ...validFinding(), evidenceIds: null }, "evidenceIds يجب"],
    [{ ...validFinding(), evidenceIds: {} }, "evidenceIds يجب"],
    [{ ...validFinding(), evidenceIds: [] }, "evidenceIds يجب"],
    [{ ...validFinding(), evidenceIds: ["ev-1", 7] }, "evidenceIds يجب"],
  ];
  for (const [element, expected] of elementCases) {
    const report = { ...base(), scopeOfWork: [element] };
    const errors = expectRejection(report, `scopeOfWork[0]=${JSON.stringify(element)}`);
    assert.ok(errors.some((line) => line.includes(expected)), `رسالة متوقعة تحتوي: ${expected}`);
  }
  // evidenceIds كنص: المرور الأول يسجل الخطأ، والمرور الثاني لا يمر على الأحرف إطلاقًا.
  const stringIds = { ...base(), scopeOfWork: [{ ...validFinding(), evidenceIds: "ev-1" }] };
  const errors = expectRejection(stringIds, "evidenceIds كنص");
  assert.ok(errors.some((line) => line.includes("evidenceIds")), "المرور الأول يسجل خطأ evidenceIds");
  assert.ok(!errors.some((line) => line.includes("الدليل e المشار")), "لا مرور على أحرف النص في سلامة المراجع");
});

test("D) evidence المشوهة: قيمة غير مصفوفة وعناصر ناقصة", () => {
  for (const value of [null, {}, "نص"]) {
    const errors = expectRejection({ ...emptyAnalysisReport(), evidence: value }, `evidence=${JSON.stringify(value)}`);
    assert.ok(errors.some((line) => line.includes("evidence")), "الخطأ يذكر evidence");
  }
  const nullElement = expectRejection({ ...emptyAnalysisReport(), evidence: [null] }, "evidence=[null]");
  assert.ok(nullElement.some((line) => line.includes("ليس كائنًا")));

  const missingCases = [
    ["evidenceId", "evidenceId مفقود"],
    ["documentId", "documentId مفقود"],
    ["sourceType", "sourceType مفقود"],
    ["chunkId", "chunkId مفقود"],
  ];
  for (const [key, expected] of missingCases) {
    const item = { ...validEvidenceItem };
    delete item[key];
    const errors = expectRejection({ ...emptyAnalysisReport(), evidence: [item] }, `evidence بلا ${key}`);
    assert.ok(errors.some((line) => line.includes(expected)), `رسالة متوقعة: ${expected}`);
  }
  const noLocation = { ...validEvidenceItem };
  delete noLocation.pageNumber;
  const locationErrors = expectRejection({ ...emptyAnalysisReport(), evidence: [noLocation] }, "evidence بلا موقع");
  assert.ok(locationErrors.some((line) => line.includes("pageNumber أو sheetName/cellRange أو section")));

  const noExcerpt = { ...validEvidenceItem };
  delete noExcerpt.excerpt;
  const excerptErrors = expectRejection({ ...emptyAnalysisReport(), evidence: [noExcerpt] }, "evidence بلا excerpt");
  assert.ok(excerptErrors.some((line) => line.includes("excerpt")));

  const longExcerpt = { ...validEvidenceItem, excerpt: "س".repeat(401) };
  const longErrors = expectRejection({ ...emptyAnalysisReport(), evidence: [longExcerpt] }, "excerpt أطول من 400");
  assert.ok(longErrors.some((line) => line.includes("400")));
});

test("E) decisionEvidenceIds وwarnings بالأنواع الخاطئة", () => {
  for (const value of [null, {}, "ev-1", 7, ["ev-1", 2]]) {
    const errors = expectRejection({ ...emptyAnalysisReport(), decisionEvidenceIds: value }, `decisionEvidenceIds=${JSON.stringify(value)}`);
    assert.ok(errors.some((line) => line.includes("decisionEvidenceIds")), "الخطأ يذكر decisionEvidenceIds");
  }
  for (const value of [null, {}, "نص", 3]) {
    const errors = expectRejection({ ...emptyAnalysisReport(), warnings: value }, `warnings=${JSON.stringify(value)}`);
    assert.ok(errors.some((line) => line.includes("warnings")), "الخطأ يذكر warnings");
  }
});

test("F) سلامة المراجع: معرفات وهمية ومكررة، والتقرير الصحيح يبقى مقبولًا", () => {
  // finding يشير إلى دليل غير موجود.
  const dangling = { ...emptyAnalysisReport(), scopeOfWork: [validFinding(["ev-404"])] };
  malformedCases += 1;
  const danglingErrors = validateAnalysisReport(dangling);
  assert.ok(danglingErrors.some((line) => line.includes("ev-404") && line.includes("غير موجود")), "مرجع وهمي مرفوض باسم المعرف");

  // decisionEvidenceIds تشير إلى دليل غير موجود.
  const danglingDecision = { ...emptyAnalysisReport(), evidence: [validEvidenceItem], decisionEvidenceIds: ["ev-404"] };
  malformedCases += 1;
  const decisionErrors = validateAnalysisReport(danglingDecision);
  assert.ok(decisionErrors.some((line) => line.includes("دليل القرار ev-404 غير موجود")), "مرجع قرار وهمي مرفوض");

  // معرفات أدلة مكررة داخل التقرير: تُرفض قبل التطبيع.
  malformedCases += 1;
  const duplicated = { ...emptyAnalysisReport(), evidence: [validEvidenceItem, { ...validEvidenceItem }] };
  assert.throws(
    () => normalizeReportEvidenceIds(duplicated, "analysis-job-p4a1r0001"),
    (error) => error.code === "ANALYSIS_OUTPUT_INVALID" && /مكرر/.test(error.message),
    "evidenceId المكرر مرفوض قبل إعادة الترقيم",
  );

  // تقرير صحيح كامل بقرار موثق يبقى مقبولًا.
  const valid = {
    ...emptyAnalysisReport(),
    scopeOfWork: [validFinding()],
    evidence: [validEvidenceItem],
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: ["ev-1"],
  };
  assert.deepEqual(validateAnalysisReport(valid), [], "التقرير الصحيح الكامل مقبول");
  assert.deepEqual(validateAnalysisReport(emptyAnalysisReport()), [], "تقرير insufficient_data الفارغ مقبول");
});

test("G) المزود بمحاكاة محلية: findings غير مصفوفة تُرفض بـAI_OUTPUT_INVALID بلا TypeError وبلا إعادة", async () => {
  const malformed = { ...emptyAnalysisReport(), scopeOfWork: { category: "scopeOfWork", statement: "كائن لا مصفوفة" } };
  let generateCalls = 0;
  const urls = [];
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url) => {
      generateCalls += 1;
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(malformed) }) };
    },
  });
  malformedCases += 1;
  const document = { documentId: "doc-p4a1r", documentType: "pdf", warnings: [] };
  const chunks = [{ chunkId: "chk-1", text: "نص جزء اختبار ثابت.", blockIds: ["b1"], sources: [{ pageNumber: 1 }] }];
  const error = await provider.analyze({ document, chunks }).then(() => null, (caught) => caught);
  assert.ok(error, "analyze يرفض المخرجات المشوهة");
  assert.equal(error.code, "AI_OUTPUT_INVALID", "الرفض مشفر بوضوح");
  assert.ok(!(error instanceof TypeError), "لا TypeError إطلاقًا");
  assert.match(error.message, /scopeOfWork/, "الرسالة تذكر الحقل المشوه");
  assert.ok(Array.isArray(error.details) && error.details.length > 0, "تفاصيل أخطاء التحقق مرفقة");
  assert.equal(generateCalls, 1, "generate يُستدعى مرة واحدة فقط — لا إعادة محاولة");
  assert.deepEqual(urls, ["http://127.0.0.1:11434/api/generate"], "لا endpoint آخر ولا اتصال حقيقي");
});

test("H) المحرك بقاعدة مؤقتة: مهمة failed بـAI_OUTPUT_INVALID دون تقرير أو findings أو evidence", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const malformed = { ...emptyAnalysisReport(), scopeOfWork: { not: "an array" } };
    let generateCalls = 0;
    const engine = createAnalysisEngine({
      repository,
      fixtureRoot,
      env: ollamaEnv,
      fetchFn: async (url) => {
        generateCalls += 1;
        assert.ok(url.endsWith("/api/generate"), "نقطة التوليد فقط");
        return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(malformed) }) };
      },
    });
    malformedCases += 1;
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    await assert.rejects(
      () => engine.runJob(job.id),
      (error) => error.code === "AI_OUTPUT_INVALID" && !(error instanceof TypeError),
      "runJob يرفض بـAI_OUTPUT_INVALID دون TypeError",
    );
    const failed = engine.getJob(job.id);
    assert.equal(failed.jobStatus, "failed", "المهمة failed ولا تبقى معلقة");
    assert.equal(failed.errorCode, "AI_OUTPUT_INVALID");
    assert.notEqual(failed.errorCode, "ANALYSIS_GROUNDING_FAILED", "grounding لا يبدأ أصلًا");
    assert.equal(failed.report, null, "report_json يبقى NULL");
    assert.equal(failed.findings.length, 0, "لا findings محفوظة");
    assert.equal(failed.modelRuns.length, 1, "model_run واحد فقط");
    assert.equal(failed.modelRuns[0].status, "failed");
    assert.equal(failed.modelRuns[0].errorCode, "AI_OUTPUT_INVALID");
    assert.equal(generateCalls, 1, "لا إعادة محاولة إطلاقًا");
    // عدّ مباشر من قاعدة SQLite المؤقتة: صفر findings وصفر evidence.
    const database = new DatabaseSync(repository.databasePath);
    try {
      const findingsRow = database.prepare("SELECT COUNT(*) AS n FROM analysis_findings WHERE job_id = ?").get(job.id);
      const evidenceRow = database.prepare("SELECT COUNT(*) AS n FROM analysis_evidence WHERE job_id = ?").get(job.id);
      assert.equal(Number(findingsRow.n), 0, "analysis_findings = 0");
      assert.equal(Number(evidenceRow.n), 0, "analysis_evidence = 0");
    } finally {
      database.close();
    }
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("I) عدم التراجع: الثوابت والإصدارات لم تتغير", () => {
  assert.equal(analysisReportSchemaVersion, "analysis-report-v2");
  assert.equal(analysisPromptVersion, "p4a-prompt-v2");
  assert.equal(analysisFindingFields.length, 12);
});

test("ملخص تغطية المدخلات المشوهة", () => {
  // A: 6 قيم كلية + 3 حقول مفقودة = 9
  // B: 12 حقلًا × 5 قيم = 60
  // C: 11 عنصرًا + evidenceIds كنص = 12
  // D: 3 قيم غير مصفوفة + null داخل مصفوفة + 4 حقول مفقودة + موقع + excerpt مفقود + excerpt طويل = 11
  // E: 5 decisionEvidenceIds + 4 warnings = 9
  // F: مرجع وهمي + مرجع قرار وهمي + تكرار = 3
  // G: مزود = 1 — H: محرك = 1
  assert.equal(malformedCases, 106, "عدد الحالات المشوهة المختبرة ثابت وحتمي");
});
