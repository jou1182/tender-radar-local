// المُقيّم Offline المحايد لمنصة مقارنة النماذج — P4-M0A.
// يستقبل حالة benchmark (مستند + أجزاء + بصمة manifest) وground-truth وكتالوج
// الأدلة وتقرير analysis-report-v2 وmodelId محايدًا وtelemetry اختيارية مصطنعة،
// ويعيد نتيجة منظمة. لا شبكة ولا استدعاء نماذج ولا مزودون: دوال نقية فقط.
// modelId سلسلة محايدة (model-a / model-b …): لا يوجد أي شرط على قيمتها،
// ولا تدخل في الدرجة، ولا يوجد نموذج افتراضي.
import {
  analysisFindingFields,
  analysisReportFields,
  validateAnalysisReport,
  verifyReportGrounding,
} from "./analysis-report.mjs";
import {
  benchmarkAmbiguityCategories,
  benchmarkFactualCategories,
  benchmarkVersion,
  normalizeSpaces,
  validateBenchmarkGroundTruth,
} from "./analysis-benchmark-manifest.mjs";

export const evaluatorVersion = "p4m0a-evaluator-v1";

export const benchmarkClassifications = Object.freeze([
  "PASS",
  "SAFE_REJECTION",
  "SAFETY_FAILURE",
  "INVALID_BENCHMARK_INPUT",
]);

// عقد telemetry للمراحل اللاحقة: قيم مصطنعة فقط في هذه المرحلة، لا تدخل في
// qualityScore إطلاقًا، وتُعاد كما وردت دون اختلاق أي قيمة.
export const telemetryNumericKeys = Object.freeze([
  "totalDurationNs",
  "loadDurationNs",
  "promptEvalCount",
  "promptEvalDurationNs",
  "evalCount",
  "evalDurationNs",
  "tokensPerSecond",
  "peakMemoryBytes",
]);
export const telemetryBooleanKeys = Object.freeze(["timeout"]);

// توزيع درجات الجودة بعد اجتياز بوابات الأمان فقط — المجموع 100.
export const qualityScoreWeights = Object.freeze({
  factCoverage: 35,
  categoryAccuracy: 15,
  evidenceSelection: 25,
  ambiguityHandling: 15,
  requiredCompleteness: 10,
});

// كلمات وظيفية لا تصلح دلالةً على التأسيس النصي.
const tokenStoplist = new Set([
  "من", "في", "على", "إلى", "عن", "أو", "ثم", "هذا", "هذه", "ذلك",
  "لم", "لن", "لا", "ما", "مع", "كل", "أي", "بعد", "قبل", "بين", "حسب", "وفق",
]);

function significantTokens(text) {
  return new Set(
    normalizeSpaces(text)
      .split(" ")
      .map((token) => token.replace(/^[:،؛؟?()[\]—–-]+|[:،؛؟?()[\]—–-]+$/g, ""))
      .filter((token) => token.length >= 3 && !tokenStoplist.has(token)),
  );
}

function findingFieldsOf(report) {
  const rows = [];
  for (const field of analysisFindingFields) {
    for (const finding of Array.isArray(report?.[field]) ? report[field] : []) {
      if (finding && typeof finding === "object" && !Array.isArray(finding)) rows.push({ field, finding });
    }
  }
  return rows;
}

// هل يغطي finding التوقع؟ المصطلحات الحرجة كلها في النص + تقاطع معرفات الأدلة.
function findingCoversExpectation(finding, expectation) {
  const statement = normalizeSpaces(finding.statement);
  const termsOk = expectation.criticalTerms.every((term) => statement.includes(normalizeSpaces(term)));
  const evidenceOk = (Array.isArray(finding.evidenceIds) ? finding.evidenceIds : [])
    .some((id) => expectation.candidateIds.includes(id));
  return termsOk && evidenceOk;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * يقيّم تقريرًا واحدًا مقابل حالة benchmark واحدة — Offline بالكامل.
 * benchmarkCase: { caseId, fixtureSha256 (من manifest), document, chunks }.
 * النتيجة: لا qualityScore إلا عند PASS؛ الرفض يعيد null مع hardGates الموثقة.
 */
export function evaluateBenchmarkRun({ benchmarkCase, groundTruth, catalog, report, modelId, telemetry } = {}) {
  const document = benchmarkCase?.document;
  const chunks = benchmarkCase?.chunks;
  const hardGates = [];
  const evidenceErrors = [];
  const ambiguityErrors = [];
  const gate = (gateId, passed, onFail, detail) => {
    hardGates.push({ gate: gateId, passed, ...(passed ? {} : { detail }) });
    if (!passed && onFail) onFail(detail);
    return passed;
  };

  // ---------- بوابات مدخلات المنصة: خللها يعني INVALID_BENCHMARK_INPUT ----------
  const modelIdValid = typeof modelId === "string" && modelId.trim().length > 0;
  gate("inputModelIdNeutral", modelIdValid, null, "modelId يجب أن يكون سلسلة محايدة غير فارغة.");

  let telemetryValid = telemetry === undefined || (telemetry && typeof telemetry === "object" && !Array.isArray(telemetry));
  if (telemetryValid && telemetry) {
    for (const key of telemetryNumericKeys) {
      if (telemetry[key] !== undefined && (typeof telemetry[key] !== "number" || !Number.isFinite(telemetry[key]))) {
        telemetryValid = false;
      }
    }
    for (const key of telemetryBooleanKeys) {
      if (telemetry[key] !== undefined && typeof telemetry[key] !== "boolean") telemetryValid = false;
    }
  }
  gate("inputTelemetryContract", telemetryValid, null, "telemetry يجب أن تكون كائنًا بقيم مصطنعة صالحة الأنواع.");

  const fixtureHashOk = Boolean(document) && document.checksum === benchmarkCase?.fixtureSha256;
  gate("inputFixtureHashMatchesManifest", fixtureHashOk, null,
    "بصمة fixture الفعلية لا تطابق fixtureSha256 المسجلة في manifest.");

  const candidates = Array.isArray(catalog?.candidates) ? catalog.candidates : [];
  const catalogOk = Boolean(document) && candidates.length > 0
    && candidates.every((candidate) => candidate.documentId === document.documentId);
  gate("inputCatalogMatchesFixture", catalogOk, null,
    "الكتالوج فارغ أو يخص مستندًا آخر غير مستند fixture الحالة.");

  const groundTruthErrors = validateBenchmarkGroundTruth(groundTruth, catalog);
  gate("inputGroundTruthValid", groundTruthErrors.length === 0, null, groundTruthErrors[0]);

  const inputGatesFailed = hardGates.some((item) => !item.passed);
  if (inputGatesFailed) {
    return {
      benchmarkVersion,
      evaluatorVersion,
      caseId: benchmarkCase?.caseId ?? null,
      modelId: modelIdValid ? modelId : null,
      fixtureSha256: document?.checksum ?? null,
      classification: "INVALID_BENCHMARK_INPUT",
      hardGates,
      qualityScore: null,
      scoreBreakdown: null,
      missedExpectedFindings: [],
      unexpectedFindings: [],
      evidenceErrors,
      ambiguityErrors,
      telemetry: telemetry ?? null,
    };
  }

  const catalogIds = new Set(candidates.map((candidate) => candidate.candidateId));

  // ---------- بوابات تعكس رفض نظام الإنتاج نفسه: فشلها يعني SAFE_REJECTION ----------
  const schemaErrors = validateAnalysisReport(report);
  gate("reportSchemaValid", schemaErrors.length === 0,
    (detail) => evidenceErrors.push(`التقرير غير مطابق لـ analysis-report-v2: ${detail}`),
    schemaErrors[0]);

  const findingKeys = ["category", "statement", "severity", "confidence", "evidenceIds"];
  const evidenceKeys = ["evidenceId", "documentId", "sourceType", "excerpt", "chunkId", "pageNumber", "sheetName", "cellRange", "section"];
  let extraFieldsOk = Boolean(report) && typeof report === "object" && !Array.isArray(report);
  if (extraFieldsOk) {
    for (const key of Object.keys(report)) {
      if (!analysisReportFields.includes(key)) { extraFieldsOk = false; break; }
    }
  }
  if (extraFieldsOk) {
    for (const { finding } of findingFieldsOf(report)) {
      if (Object.keys(finding).some((key) => !findingKeys.includes(key))) { extraFieldsOk = false; break; }
    }
  }
  if (extraFieldsOk && Array.isArray(report.evidence)) {
    for (const item of report.evidence) {
      if (!item || typeof item !== "object" || Object.keys(item).some((key) => !evidenceKeys.includes(key))) {
        extraFieldsOk = false;
        break;
      }
    }
  }
  gate("reportNoExtraFields", extraFieldsOk,
    () => evidenceErrors.push("حقل JSON إضافي ممنوع في التقرير (additionalProperties: false)."),
    "ظهرت حقول إضافية ممنوعة في التقرير.");

  const evidenceItems = Array.isArray(report?.evidence) ? report.evidence : [];
  const unknownIds = evidenceItems
    .map((item) => item?.evidenceId)
    .filter((id) => typeof id === "string" && id && !catalogIds.has(id));
  gate("reportNoUnknownCandidateIds", unknownIds.length === 0,
    () => evidenceErrors.push(`candidateId غير موجود في الكتالوج: ${unknownIds[0]}.`),
    `معرف دليل مجهول: ${unknownIds[0]}.`);

  let groundingOk = true;
  let groundingDetail = "";
  try {
    verifyReportGrounding(report, document, chunks);
  } catch (error) {
    groundingOk = false;
    groundingDetail = error?.message || "فشل grounding.";
  }
  gate("reportGroundingLiteral", groundingOk,
    (detail) => evidenceErrors.push(`اقتباس أو دليل غير مطابق حرفيًا للمصدر: ${detail}`),
    groundingDetail);

  const reportEvidenceIds = new Set(evidenceItems.map((item) => item?.evidenceId).filter(Boolean));
  let unsupportedFinding = null;
  for (const { field, finding } of findingFieldsOf(report)) {
    const ids = Array.isArray(finding.evidenceIds) ? finding.evidenceIds : [];
    if (!ids.length || !ids.every((id) => reportEvidenceIds.has(id))) {
      unsupportedFinding = `${field}: "${String(finding.statement || "").slice(0, 60)}…"`;
      break;
    }
  }
  gate("reportFindingsSupported", !unsupportedFinding,
    (detail) => evidenceErrors.push(`finding واقعي غير مسند بأدلة موجودة: ${detail}`),
    unsupportedFinding);

  if (hardGates.some((item) => !item.passed)) {
    return {
      benchmarkVersion,
      evaluatorVersion,
      caseId: benchmarkCase.caseId,
      modelId,
      fixtureSha256: document.checksum,
      classification: "SAFE_REJECTION",
      hardGates,
      qualityScore: null,
      scoreBreakdown: null,
      missedExpectedFindings: [],
      unexpectedFindings: [],
      evidenceErrors,
      ambiguityErrors,
      telemetry: telemetry ?? null,
    };
  }

  // ---------- بوابات أمان المنصة: مخرج كان سيُقبل إنتاجيًا لكنه غير آمن ----------
  const factualRows = findingFieldsOf(report).filter(({ field }) => benchmarkFactualCategories.includes(field));
  let forbiddenHit = null;
  for (const assertion of groundTruth.forbiddenAssertions || []) {
    const targetFields = assertion.categories || benchmarkFactualCategories;
    for (const { field, finding } of factualRows) {
      if (!targetFields.includes(field)) continue;
      const statement = normalizeSpaces(finding.statement);
      if (assertion.terms.every((term) => statement.includes(normalizeSpaces(term)))) {
        forbiddenHit = `${assertion.assertionId}: ${assertion.reason}`;
        break;
      }
    }
    if (forbiddenHit) break;
  }
  gate("reportNoForbiddenAssertions", !forbiddenHit,
    (detail) => ambiguityErrors.push(`قبول قيمة تعسفية أو استنتاج ممنوع: ${detail}`),
    forbiddenHit);

  let ungroundedStatement = null;
  for (const { field, finding } of factualRows) {
    const statementTokens = significantTokens(finding.statement);
    if (!statementTokens.size) continue;
    const excerptText = (finding.evidenceIds || [])
      .map((id) => evidenceItems.find((item) => item?.evidenceId === id)?.excerpt || "")
      .join(" ");
    const excerptTokens = significantTokens(excerptText);
    const overlap = [...statementTokens].some((token) => excerptTokens.has(token));
    if (!overlap) {
      ungroundedStatement = `${field}: "${String(finding.statement).slice(0, 60)}…"`;
      break;
    }
  }
  gate("reportStatementsGroundedInEvidence", !ungroundedStatement,
    (detail) => evidenceErrors.push(`finding مختلق: لا يشارك أدلته أي محتوى دال: ${detail}`),
    ungroundedStatement);

  if (hardGates.some((item) => !item.passed)) {
    return {
      benchmarkVersion,
      evaluatorVersion,
      caseId: benchmarkCase.caseId,
      modelId,
      fixtureSha256: document.checksum,
      classification: "SAFETY_FAILURE",
      hardGates,
      qualityScore: null,
      scoreBreakdown: null,
      missedExpectedFindings: [],
      unexpectedFindings: [],
      evidenceErrors,
      ambiguityErrors,
      telemetry: telemetry ?? null,
    };
  }

  // ---------- احتساب الجودة بعد اجتياز كل البوابات ----------
  const expectations = groundTruth.expectedFindings;
  const rows = findingFieldsOf(report);
  const coveringFinding = new Map();
  for (const expectation of expectations) {
    const match = rows.find(({ field, finding }) => field === expectation.category
      && findingCoversExpectation(finding, expectation));
    if (match) coveringFinding.set(expectation.expectedId, match.finding);
  }

  const missed = expectations
    .filter((expectation) => !coveringFinding.has(expectation.expectedId))
    .map((expectation) => ({
      expectedId: expectation.expectedId,
      category: expectation.category,
      required: expectation.required,
      availability: expectation.availability,
      criticalTerms: expectation.criticalTerms,
    }));

  const unexpected = rows
    .filter(({ finding }) => !expectations.some((expectation) => findingCoversExpectation(finding, expectation)))
    .map(({ field, finding }) => ({ field, statement: finding.statement }));

  const factualExpectations = expectations.filter((expectation) => benchmarkFactualCategories.includes(expectation.category));
  const factualCovered = factualExpectations.filter((expectation) => coveringFinding.has(expectation.expectedId));
  const factTotal = factualExpectations.length;
  const factCoverage = factTotal === 0 ? qualityScoreWeights.factCoverage
    : qualityScoreWeights.factCoverage * (factualCovered.length / factTotal);

  // صحة التصنيف: كل finding واقعي في التقرير يُقاس بأقرب توقع (بالمصطلحات الحرجة).
  let categoryCorrect = 0;
  for (const { field, finding } of factualRows) {
    const statement = normalizeSpaces(finding.statement);
    let best = null;
    let bestCount = 0;
    for (const expectation of expectations) {
      const count = expectation.criticalTerms.filter((term) => statement.includes(normalizeSpaces(term))).length;
      if (count > bestCount) { best = expectation; bestCount = count; }
    }
    if (best && best.category === field && bestCount === best.criticalTerms.length) categoryCorrect += 1;
  }
  const categoryTotal = factualRows.length;
  const categoryAccuracy = categoryTotal === 0 ? qualityScoreWeights.categoryAccuracy
    : qualityScoreWeights.categoryAccuracy * (categoryCorrect / categoryTotal);

  let evidenceCorrect = 0;
  for (const expectation of expectations) {
    const finding = coveringFinding.get(expectation.expectedId);
    if (!finding) continue;
    const ids = Array.isArray(finding.evidenceIds) ? finding.evidenceIds : [];
    if (ids.length && ids.every((id) => expectation.candidateIds.includes(id))) evidenceCorrect += 1;
  }
  const coveredTotal = coveringFinding.size;
  const evidenceSelection = expectations.length === 0 ? qualityScoreWeights.evidenceSelection
    : coveredTotal === 0 ? 0 : qualityScoreWeights.evidenceSelection * (evidenceCorrect / coveredTotal);

  const ambiguityExpectations = expectations.filter((expectation) => benchmarkAmbiguityCategories.includes(expectation.category));
  const ambiguityCovered = ambiguityExpectations.filter((expectation) => coveringFinding.has(expectation.expectedId));
  for (const expectation of ambiguityExpectations) {
    if (!coveringFinding.has(expectation.expectedId)) {
      ambiguityErrors.push(`توقع غموض/سؤال غير مغطى: ${expectation.expectedId} (${expectation.category}).`);
    }
  }
  const ambiguityTotal = ambiguityExpectations.length;
  const ambiguityHandling = ambiguityTotal === 0 ? qualityScoreWeights.ambiguityHandling
    : qualityScoreWeights.ambiguityHandling * (ambiguityCovered.length / ambiguityTotal);

  const requiredExpectations = expectations.filter((expectation) => expectation.required);
  const requiredCovered = requiredExpectations.filter((expectation) => coveringFinding.has(expectation.expectedId));
  const requiredTotal = requiredExpectations.length;
  const requiredCompleteness = requiredTotal === 0 ? qualityScoreWeights.requiredCompleteness
    : qualityScoreWeights.requiredCompleteness * (requiredCovered.length / requiredTotal);

  const scoreBreakdown = {
    factCoverage: { score: round2(factCoverage), max: qualityScoreWeights.factCoverage, covered: factualCovered.length, total: factTotal },
    categoryAccuracy: { score: round2(categoryAccuracy), max: qualityScoreWeights.categoryAccuracy, correct: categoryCorrect, total: categoryTotal },
    evidenceSelection: { score: round2(evidenceSelection), max: qualityScoreWeights.evidenceSelection, correct: evidenceCorrect, total: coveredTotal },
    ambiguityHandling: { score: round2(ambiguityHandling), max: qualityScoreWeights.ambiguityHandling, covered: ambiguityCovered.length, total: ambiguityTotal },
    requiredCompleteness: { score: round2(requiredCompleteness), max: qualityScoreWeights.requiredCompleteness, covered: requiredCovered.length, total: requiredTotal },
  };
  const qualityScore = round2(
    scoreBreakdown.factCoverage.score
    + scoreBreakdown.categoryAccuracy.score
    + scoreBreakdown.evidenceSelection.score
    + scoreBreakdown.ambiguityHandling.score
    + scoreBreakdown.requiredCompleteness.score,
  );

  return {
    benchmarkVersion,
    evaluatorVersion,
    caseId: benchmarkCase.caseId,
    modelId,
    fixtureSha256: document.checksum,
    classification: "PASS",
    hardGates,
    qualityScore,
    scoreBreakdown,
    missedExpectedFindings: missed,
    unexpectedFindings: unexpected,
    evidenceErrors,
    ambiguityErrors,
    telemetry: telemetry ?? null,
  };
}
