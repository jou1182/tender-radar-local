// اختبارات P4-A1D0 المحدثة لـ P4-M0BR0: كتالوج أدلة حرفية حتمي واختيار الأدلة بالمعرف فقط.
// النموذج لا يكتب excerpt ولا statement ولا summary ولا warnings إطلاقًا؛
// البرنامج يستخرج المرشحين محليًا ويعيد بناء التقرير canonical حتميًا بالكامل.
// P4-M0BR0: إغلاق النصوص الواقعية الحرة — المخطط الداخلي v2 بلا أي حقل نصي،
// والملخص يُبنى حرفيًا من بنود الأدلة المجتازة، وبلا بنود يفشل الاختيار بأمان
// (AI_NO_GROUNDED_SELECTION) بدل أي fallback غير مؤسس.
// محاكاة محلية فقط: بلا Ollama حي، بلا شبكة، بلا Chrome أو اعتماد، وبلا مستندات حقيقية.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { extractAnalysisDocument } from "../scripts/lib/analysis-documents.mjs";
import { chunkAnalysisDocument } from "../scripts/lib/analysis-chunking.mjs";
import {
  analysisFindingFields,
  analysisPromptVersion,
  analysisReportSchemaVersion,
  normalizeReportEvidenceIds,
  validateAnalysisReport,
  verifyReportGrounding,
} from "../scripts/lib/analysis-report.mjs";
import {
  buildEvidenceCandidateCatalog,
  createEvidenceCandidateId,
  evidenceCandidateLimits,
  materializeEvidenceFromCandidates,
} from "../scripts/lib/analysis-evidence-candidates.mjs";
import {
  buildModelSelectionPrompt,
  buildModelSelectionSchema,
  materializeCanonicalReport,
  modelSelectionSchemaVersion,
  validateModelSelection,
} from "../scripts/lib/analysis-model-selection.mjs";
import { createOllamaProvider } from "../scripts/lib/analysis-providers.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";
import { buildFixtureBuffers } from "./helpers/analysis-fixture-factory.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));
const fixtureBuffers = buildFixtureBuffers();
const ollamaEnv = { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" };

// حاجز الاتصال: أي محاولة fetch حقيقية تسقط الاختبار فورًا.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("REAL_NETWORK_FORBIDDEN: استخدم fetchFn وهميًا"); };
after(() => { globalThis.fetch = realFetch; });

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4a1d0-"));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

async function cleanup(projectRoot, repository) {
  repository?.close();
  await rm(projectRoot, { recursive: true, force: true });
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fixtureDocument(key, fileName, documentId) {
  const document = extractAnalysisDocument({ documentId, fileName, buffer: fixtureBuffers[key] });
  return { document, chunks: chunkAnalysisDocument(document) };
}

const fixtureSet = [
  ["booklet-pdf", "booklet-sample.pdf", "pdf"],
  ["boq-xlsx", "boq-sample.xlsx", "xlsx"],
  ["conditions-docx", "conditions-sample.docx", "docx"],
];

function emptySelection() {
  return {
    ...Object.fromEntries(analysisFindingFields.map((field) => [field, []])),
    preliminaryDecision: "insufficient_data",
    confidence: "low",
    decisionEvidenceIds: [],
  };
}

function resolveRef(root, node) {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    return root.$defs[node.$ref.replace("#/$defs/", "")];
  }
  return node;
}

test("A) استخراج المرشحين من PDF وXLSX وDOCX: حرفية وموقع وchunk ولا تكرار", () => {
  for (const [key, fileName, type] of fixtureSet) {
    const { document, chunks } = fixtureDocument(key, fileName, `doc-a-${type}`);
    const catalog = buildEvidenceCandidateCatalog({ document, chunks });
    assert.ok(catalog.candidates.length > 0, `${type}: مرشحون مستخرجون`);
    const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
    const ids = new Set();
    for (const candidate of catalog.candidates) {
      // المقتطف substring حرفي من نص الكتلة ونص الجزء بعد التطبيع.
      const block = document.blocks.find((item) => item.blockId === candidate.blockId.split("#")[0]);
      assert.ok(block, `${type}: الكتلة المرتبطة موجودة`);
      assert.ok(normalizeSpaces(block.text).includes(candidate.excerpt), `${type}: excerpt حرفي من الكتلة`);
      const chunk = chunkById.get(candidate.chunkId);
      assert.ok(chunk, `${type}: الجزء موجود`);
      assert.ok(normalizeSpaces(chunk.text).includes(candidate.excerpt), `${type}: excerpt حرفي من الجزء`);
      assert.ok(chunk.blockIds.includes(candidate.blockId), `${type}: chunkId يحتوي blockId — لا عبور بين blocks`);
      // الطول ضمن 8–400.
      assert.ok(candidate.excerpt.length >= 8 && candidate.excerpt.length <= 400, `${type}: الطول ضمن الحدود`);
      // الموقع مطابق للكتلة.
      assert.equal(candidate.sourceType, document.documentType);
      assert.deepEqual(
        { pageNumber: candidate.pageNumber, sheetName: candidate.sheetName, cellRange: candidate.cellRange, section: candidate.section },
        { pageNumber: block.source.pageNumber, sheetName: block.source.sheetName, cellRange: block.source.cellRange, section: block.source.section },
        `${type}: الموقع مطابق للكتلة`,
      );
      assert.ok(Number.isInteger(candidate.startOffset) && candidate.endOffset > candidate.startOffset);
      assert.ok(!ids.has(candidate.candidateId), `${type}: لا candidateId مكرر`);
      ids.add(candidate.candidateId);
      assert.match(candidate.candidateId, /^cand-[0-9a-f]{24}$/);
    }
  }
});

test("B) الحتمية: تشغيلان متطابقان، وتغيير حرف أو موقع أو إزاحة يغير المعرف", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-det");
  const first = buildEvidenceCandidateCatalog({ document, chunks });
  const second = buildEvidenceCandidateCatalog({ document, chunks });
  assert.deepEqual(first.candidates, second.candidates, "نفس المدخلات تنتج الكتالوج نفسه");
  assert.deepEqual(first.candidates.map((c) => c.candidateId), second.candidates.map((c) => c.candidateId), "نفس المعرفات والترتيب");

  const changedText = { ...document, blocks: document.blocks.map((b, i) => (i === 0 ? { ...b, text: `${b.text}!` } : b)) };
  const changedTextCatalog = buildEvidenceCandidateCatalog({ document: changedText, chunks });
  assert.notDeepEqual(
    changedTextCatalog.candidates.map((c) => c.candidateId),
    first.candidates.map((c) => c.candidateId),
    "تغيير حرف في النص يغير المعرفات",
  );

  const changedLocation = { ...document, blocks: document.blocks.map((b, i) => (i === 0 ? { ...b, source: { pageNumber: 99 } } : b)) };
  const changedLocationCatalog = buildEvidenceCandidateCatalog({ document: changedLocation, chunks });
  const firstBlockIds = (catalog) => catalog.candidates.filter((c) => c.blockId === first.candidates[0].blockId).map((c) => c.candidateId);
  assert.notDeepEqual(firstBlockIds(changedLocationCatalog), firstBlockIds(first), "تغيير الموقع يغير المعرف");

  // دالة المعرف نفسها حتمية وحساسة لكل مدخل: النص والموقع والإزاحات.
  const base = { checksum: "c", documentId: "d", blockId: "b", chunkId: "k", source: { pageNumber: 1 }, startOffset: 0, endOffset: 5, excerpt: "نص تجريبي" };
  assert.equal(createEvidenceCandidateId(base), createEvidenceCandidateId({ ...base }));
  assert.notEqual(createEvidenceCandidateId(base), createEvidenceCandidateId({ ...base, excerpt: "نص آخر" }));
  assert.notEqual(createEvidenceCandidateId(base), createEvidenceCandidateId({ ...base, startOffset: 1 }));
  assert.notEqual(createEvidenceCandidateId(base), createEvidenceCandidateId({ ...base, endOffset: 6 }));
  assert.notEqual(createEvidenceCandidateId(base), createEvidenceCandidateId({ ...base, source: { pageNumber: 2 } }));
});

test("C) الحدود: 48 مرشحًا و6000 حرف كحد أقصى، قص حتمي، وwarning بعدد المستبعد", () => {
  const manyBlocks = Array.from({ length: 80 }, (_, index) => ({
    blockId: `b${index + 1}`,
    kind: "paragraph",
    text: `سطر اختبار قصير رقم ${index + 1}`,
    source: { section: "قسم الحدود" },
  }));
  const document = { documentId: "doc-limits", documentType: "docx", checksum: "limits", blocks: manyBlocks, warnings: [] };
  const chunks = [{ chunkId: "chk-limits", text: manyBlocks.map((b) => b.text).join("\n"), blockIds: manyBlocks.map((b) => b.blockId), sources: [{ section: "قسم الحدود" }] }];
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  assert.equal(catalog.candidates.length, evidenceCandidateLimits.maxCandidates, "48 مرشحًا كحد أقصى");
  assert.ok(catalog.totalExcerptChars <= evidenceCandidateLimits.maxTotalExcerptChars, "مجموع المقتطفات ≤ 6000");
  assert.ok(catalog.candidates.every((c) => c.excerpt.length <= evidenceCandidateLimits.maxExcerptChars), "كل مقتطف ≤ 400");
  assert.ok(catalog.excludedCount > 0, "عناصر مستبعدة محسوبة");
  assert.equal(catalog.excludedCount, catalog.generatedCount - catalog.candidates.length);
  assert.ok(catalog.warnings.some((warning) => warning.includes(String(catalog.excludedCount))), "warning داخلي بعدد المستبعد");
  // القص حتمي: تشغيلان ينتجان القائمة نفسها.
  const again = buildEvidenceCandidateCatalog({ document, chunks });
  assert.deepEqual(again.candidates.map((c) => c.candidateId), catalog.candidates.map((c) => c.candidateId), "القص حتمي");

  // حد الأحرف يقص قبل تجاوزه حتى مع عدد قليل من المرشحين الطويلة.
  const longBlocks = Array.from({ length: 20 }, (_, index) => ({
    blockId: `L${index + 1}`,
    kind: "paragraph",
    text: `كلمة${index} `.repeat(60).trim(),
    source: { section: "قسم طويل" },
  }));
  const longDocument = { documentId: "doc-long-limits", documentType: "docx", checksum: "long", blocks: longBlocks, warnings: [] };
  const longChunks = [{ chunkId: "chk-long", text: longBlocks.map((b) => b.text).join("\n"), blockIds: longBlocks.map((b) => b.blockId), sources: [{ section: "قسم طويل" }] }];
  const longCatalog = buildEvidenceCandidateCatalog({ document: longDocument, chunks: longChunks });
  assert.ok(longCatalog.totalExcerptChars <= evidenceCandidateLimits.maxTotalExcerptChars, "حد الأحرف الإجمالي مطبق");
  assert.ok(longCatalog.excludedCount > 0, "القص بالأحرف حدث قبل حد العدد");
  assert.ok(longCatalog.candidates.length < longCatalog.generatedCount);
});

test("D) schema v2: مخطط الاختيار الداخلي مغلق تماماً ولا يسمح بأي نص واقعي حر", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-d");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const allowedIds = catalog.candidates.map((c) => c.candidateId);
  const schema = buildModelSelectionSchema(catalog.candidates);

  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false, "additionalProperties مغلق عند الجذر");
  assert.equal(schema.required.length, 15, "15 حقل في v2 (12 فئة + 3 حقول قرار/يقين)");
  assert.ok(!schema.properties.executiveSummary, "executiveSummary ممنوع في المخطط الداخلي");
  assert.ok(!schema.properties.warnings, "warnings ممنوع في المخطط الداخلي");

  assert.equal(analysisFindingFields.length, 12);
  for (const field of analysisFindingFields) {
    const list = resolveRef(schema, schema.properties[field]);
    assert.equal(list.type, "array", `${field} مصفوفة`);
    const finding = resolveRef(schema, list.items);
    assert.equal(finding, schema.$defs.selectionFinding);
  }

  const finding = schema.$defs.selectionFinding;
  assert.equal(finding.additionalProperties, false, "additionalProperties مغلق عند الفئة");
  assert.ok(!finding.properties.statement, "statement ممنوع في الفئة");
  assert.ok(!finding.properties.category, "category غير مطلوبة داخل الفئة");
  assert.equal(finding.properties.evidenceIds.type, "array");
  assert.equal(finding.properties.evidenceIds.minItems, 1);
  assert.deepEqual(finding.properties.evidenceIds.items.enum, allowedIds, "evidenceIds enum من معرفات المرشحين");
  assert.deepEqual(schema.properties.decisionEvidenceIds.items.enum, allowedIds, "decisionEvidenceIds enum من القائمة نفسها");
  assert.ok(!allowedIds.includes("cand-unknown"), "معرف مجهول ليس ضمن enum");

  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, "قابل للتسلسل الكامل");
  assert.ok(Object.isFrozen(schema) && Object.isFrozen(schema.$defs.selectionFinding), "المخطط مجمد");
  assert.equal(modelSelectionSchemaVersion, "analysis-model-selection-v2");
});

test("E) prompt v4: اختيار بالمعرف فقط، بلا نصوص، ضمن الميزانية وبلا مسارات", () => {
  assert.equal(analysisPromptVersion, "p4a-prompt-v4", "إصدار prompt الجديد");
  assert.equal(analysisReportSchemaVersion, "analysis-report-v2", "صيغة التقرير canonical باقية");
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-prompt");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const prompt = buildModelSelectionPrompt({ document, catalog });

  for (const candidate of catalog.candidates) assert.ok(prompt.includes(candidate.candidateId), "المعرف معروض");
  assert.match(prompt, /تصنيف وتوزيع معرفات الأدلة|اختر واحدًا أو أكثر/, "يطلب الاختيار فقط");
  assert.match(prompt, /ممنوع منعًا باتًا/, "يمنع كتابة الأدلة صراحة");
  assert.match(prompt, /لا تكتب أي نص أو statement/, "يمنع النصوص صراحة");
  assert.match(prompt, /مرجع للقراءة فقط/, "المقتطفات مرجع قراءة فقط");
  assert.match(prompt, /insufficient_data/, "يسمح بـinsufficient_data عند غياب الأدلة");
  assert.match(prompt, /decisionEvidenceIds/, "يطلب أدلة القرار");
  assert.doesNotMatch(prompt, /انسخ excerpt|اكتب excerpt/, "لا يطلب كتابة مقتطف إطلاقًا");

  assert.ok(catalog.totalExcerptChars <= 6_000, "ميزانية المقتطفات مطبقة");
  assert.ok(prompt.length < 9_000, "الـprompt الكلي محدود");
  assert.ok(!prompt.includes(document.fileName || "booklet-sample.pdf"), "لا أسماء ملفات");
  assert.ok(!prompt.includes(fixtureRoot), "لا مسارات ملفات");
});

test("F) materialization: تقرير canonical v2 بأدلة محلية حرفية يجتاز التحقق والتطبيع وgrounding", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-mat");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const [first, second] = catalog.candidates;
  const selection = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [first.candidateId, second.candidateId] }],
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: [first.candidateId],
  };
  const report = materializeCanonicalReport(selection, catalog);
  assert.deepEqual(validateAnalysisReport(report), [], "التقرير المعاد بناؤه يطابق analysis-report-v2");
  assert.equal(report.evidence.length, 2, "evidence مبنية محليًا من الكتالوج فقط");
  assert.equal(report.evidence[0].evidenceId, first.candidateId, "evidenceId = candidateId قبل التطبيع");
  assert.equal(report.evidence[0].excerpt, first.excerpt, "excerpt حرفي من الكتالوج");
  assert.equal(report.evidence[0].pageNumber, first.pageNumber, "الموقع من الكتالوج");
  assert.equal(report.evidence[0].chunkId, first.chunkId);
  assert.equal(report.evidence[0].documentId, document.documentId);
  assert.equal(verifyReportGrounding(report, document, chunks), true, "grounding ينجح بلا تخفيف");
  const normalized = normalizeReportEvidenceIds(report, "analysis-job-p4a1d0mat01");
  assert.match(normalized.evidence[0].evidenceId, /^ev-[a-zA-Z0-9]+-1$/, "التطبيع يعيد الترقيم بنطاق المهمة");
  assert.deepEqual(normalized.scopeOfWork[0].evidenceIds, normalized.evidence.map((e) => e.evidenceId), "المراجع أُعيدت كتابتها دون كسر");
  assert.deepEqual(normalized.decisionEvidenceIds, [normalized.evidence[0].evidenceId]);
  assert.deepEqual(validateAnalysisReport(normalized), [], "صالح بعد التطبيع");
  assert.equal(verifyReportGrounding(normalized, document, chunks), true, "grounding ناجح بعد التطبيع");
});

test("G) معرف مجهول: AI_OUTPUT_INVALID في الوحدة والمزود، بلا تقرير وبلا findings", async () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-unknown");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const selection = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: ["cand-000000000000000000000000"] }],
    preliminaryDecision: "review",
    decisionEvidenceIds: ["cand-000000000000000000000000"],
  };
  const errors = validateModelSelection(selection, catalog.candidates);
  assert.ok(errors.some((line) => line.includes("cand-000000000000000000000000") && line.includes("مجهول")), "المعرف المجهول مرفوض باسمه");
  assert.throws(() => materializeCanonicalReport(selection, catalog), (error) => error.code === "AI_OUTPUT_INVALID" && !(error instanceof TypeError));
  assert.throws(() => materializeEvidenceFromCandidates(["cand-ffffffffffffffffffffffff"], catalog), (error) => error.code === "AI_OUTPUT_INVALID");

  let generateCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url) => {
      generateCalls += 1;
      assert.ok(url.endsWith("/api/generate"));
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection) }) };
    },
  });
  const error = await provider.analyze({ document, chunks }).then(() => null, (caught) => caught);
  assert.equal(error.code, "AI_OUTPUT_INVALID");
  assert.ok(!(error instanceof TypeError), "لا TypeError");
  assert.ok(Array.isArray(error.details) && error.details.length > 0, "تفاصيل التحقق مرفقة");
  assert.equal(generateCalls, 1, "لا إعادة محاولة");
});

test("H) استجابات مشوهة: كائن بدل مصفوفة وIDs غير مصفوفة ومكررة وقرار بلا أدلة وحقول نصية زائدة — كلها مرفوضة بلا TypeError", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-malformed");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const id = catalog.candidates[0].candidateId;
  const cases = [
    ["كائن بدل مصفوفة فئة", { ...emptySelection(), scopeOfWork: { severity: "info", confidence: "low", evidenceIds: [id] } }, /scopeOfWork/],
    ["evidenceIds كنص", { ...emptySelection(), scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: id }] }, /evidenceIds/],
    ["IDs مكررة داخل finding", {
      ...emptySelection(),
      scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: [id, id] }],
      preliminaryDecision: "review",
      decisionEvidenceIds: [id],
    }, /مكرر/],
    ["قرار نهائي بلا decisionEvidenceIds", { ...emptySelection(), preliminaryDecision: "enter" }, /decisionEvidenceIds/],
    ["معرف قرار مكرر", { ...emptySelection(), preliminaryDecision: "review", decisionEvidenceIds: [id, id] }, /مكرر/],
    ["حقل evidence زائد", { ...emptySelection(), evidence: [] }, /evidence/],
    ["حقل statement زائد داخل الفئة", { ...emptySelection(), scopeOfWork: [{ statement: "نص واقعي حر", severity: "info", confidence: "low", evidenceIds: [id] }] }, /statement|حقل غير مسموح/],
    ["حقل category زائد داخل الفئة", { ...emptySelection(), scopeOfWork: [{ category: "scopeOfWork", severity: "info", confidence: "low", evidenceIds: [id] }] }, /category|حقل غير مسموح/],
    ["حقل executiveSummary زائد بالجذر", { ...emptySelection(), executiveSummary: "ملخص حر" }, /executiveSummary|حقل غير مسموح/],
    ["حقل warnings زائد بالجذر", { ...emptySelection(), warnings: ["تحذير حر"] }, /warnings|حقل غير مسموح/],
    ["قيمة كلية ليست كائنًا", null, /كائن JSON/],
    ["مصفوفة كلية", [], /كائن JSON/],
  ];
  for (const [label, value, expected] of cases) {
    let errors = null;
    assert.doesNotThrow(() => { errors = validateModelSelection(value, catalog.candidates); }, `${label}: لا TypeError`);
    assert.ok(Array.isArray(errors) && errors.length > 0, `${label}: مرفوض`);
    assert.ok(errors.some((line) => expected.test(line)), `${label}: الرسالة تطابق ${expected}`);
    assert.throws(
      () => materializeCanonicalReport(value, catalog),
      (error) => error.code === "AI_OUTPUT_INVALID" && !(error instanceof TypeError),
      `${label}: materialize يرفض بلا TypeError`,
    );
  }
});

test("I) المحرك بـfetchFn وهمي: مهمة completed وتقرير محفوظ وfindings/evidence وmodel_run succeeded واحد بـ p4a-prompt-v4", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    let generateCalls = 0;
    const selectingFetch = async (url, options) => {
      generateCalls += 1;
      assert.ok(url.endsWith("/api/generate"), "نقطة التوليد فقط");
      const { prompt, format } = JSON.parse(options.body);
      assert.ok(!("evidence" in format.properties), "format هو مخطط الاختيار الداخلي بلا evidence");
      assert.ok(!("executiveSummary" in format.properties), "format هو مخطط الاختيار الداخلي بلا executiveSummary");
      assert.ok(!("warnings" in format.properties), "format هو مخطط الاختيار الداخلي بلا warnings");
      const ids = [...prompt.matchAll(/\[(cand-[0-9a-f]{24})\]/g)].map((match) => match[1]);
      assert.ok(ids.length > 0, "الكتالوج معروض في الـprompt");
      const selection = {
        ...emptySelection(),
        scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [ids[0], ids[1] || ids[0]] }],
        preliminaryDecision: "review",
        confidence: "medium",
        decisionEvidenceIds: [ids[0]],
      };
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection) }) };
    };
    const engine = createAnalysisEngine({ repository, fixtureRoot, env: ollamaEnv, fetchFn: selectingFetch });
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    const done = await engine.runJob(job.id);
    assert.equal(done.jobStatus, "completed");
    assert.equal(generateCalls, 1, "محاولة واحدة بلا إعادة");
    assert.ok(done.report, "التقرير محفوظ");
    assert.ok(done.report.evidence.length >= 1, "evidence محفوظة من الكتالوج");
    assert.ok(done.findings.length >= 1, "findings محفوظة");
    assert.equal(done.modelRuns.length, 1, "model_run واحد");
    assert.equal(done.modelRuns[0].status, "succeeded");
    assert.equal(done.modelRuns[0].promptVersion, "p4a-prompt-v4");
    assert.equal(done.modelRuns[0].outputSchemaVersion, "analysis-report-v2");
    assert.deepEqual(validateAnalysisReport(done.report), [], "التقرير المحفوظ صالح");
    const evidenceIds = new Set(done.report.evidence.map((item) => item.evidenceId));
    for (const finding of done.findings) {
      for (const ref of finding.evidenceIds) assert.ok(evidenceIds.has(ref), "مرجع finding محلول بعد التطبيع");
    }
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("J) فشل آمن: معرف مجهول عبر المحرك — failed بلا تقرير ولا findings/evidence ولا retry", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    let generateCalls = 0;
    const tamperedFetch = async () => {
      generateCalls += 1;
      const selection = {
        ...emptySelection(),
        scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: ["cand-eeeeeeeeeeeeeeeeeeeeeeee"] }],
        preliminaryDecision: "review",
        decisionEvidenceIds: ["cand-eeeeeeeeeeeeeeeeeeeeeeee"],
      };
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection) }) };
    };
    const engine = createAnalysisEngine({ repository, fixtureRoot, env: ollamaEnv, fetchFn: tamperedFetch });
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    await assert.rejects(() => engine.runJob(job.id), (error) => error.code === "AI_OUTPUT_INVALID" && !(error instanceof TypeError));
    const failed = engine.getJob(job.id);
    assert.equal(failed.jobStatus, "failed");
    assert.equal(failed.errorCode, "AI_OUTPUT_INVALID", "errorCode واضح");
    assert.equal(failed.report, null, "report_json يبقى NULL");
    assert.equal(failed.findings.length, 0);
    assert.equal(failed.modelRuns.length, 1, "model_run واحد failed");
    assert.equal(failed.modelRuns[0].status, "failed");
    assert.equal(failed.modelRuns[0].errorCode, "AI_OUTPUT_INVALID");
    assert.equal(generateCalls, 1, "لا إعادة محاولة تلقائية");
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

test("K) حاجز grounding: تلاعب محلي بعد materialization يُرفض بلا تخفيف ولا fuzzy", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-tamper");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const id = catalog.candidates[0].candidateId;
  const selection = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [id] }],
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: [id],
  };
  const report = materializeCanonicalReport(selection, catalog);
  assert.equal(verifyReportGrounding(report, document, chunks), true, "الأصل سليم");
  // مقتطف معدّل بحرف واحد يسقط.
  const tamperedExcerpt = { ...report, evidence: [{ ...report.evidence[0], excerpt: `${report.evidence[0].excerpt} مضاف` }] };
  assert.throws(() => verifyReportGrounding(tamperedExcerpt, document, chunks), (error) => error.code === "ANALYSIS_GROUNDING_FAILED");
  const tamperedLocation = { ...report, evidence: [{ ...report.evidence[0], pageNumber: 99 }] };
  assert.throws(() => verifyReportGrounding(tamperedLocation, document, chunks), (error) => error.code === "ANALYSIS_GROUNDING_FAILED");
  // chunk معدّل يسقط.
  const tamperedChunk = { ...report, evidence: [{ ...report.evidence[0], chunkId: "chk-0000000000000000" }] };
  assert.throws(() => verifyReportGrounding(tamperedChunk, document, chunks), (error) => error.code === "ANALYSIS_GROUNDING_FAILED");
});

test("L) بلا مرشحين: لا استدعاء للنموذج إطلاقًا وفشل آمن مشفر", async () => {
  const tinyDocument = {
    documentId: "doc-tiny",
    documentType: "pdf",
    checksum: "tiny",
    warnings: [],
    blocks: [{ blockId: "b1", kind: "page-text", text: "قصير", source: { pageNumber: 1 } }],
  };
  const tinyChunks = [{ chunkId: "chk-tiny", text: "قصير", blockIds: ["b1"], sources: [{ pageNumber: 1 }] }];
  const catalog = buildEvidenceCandidateCatalog({ document: tinyDocument, chunks: tinyChunks });
  assert.equal(catalog.candidates.length, 0, "مقطع دون الحد الأدنى لا ينتج مرشحًا");
  let fetchCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => { fetchCalls += 1; throw new Error("must not be called"); },
  });
  await assert.rejects(
    () => provider.analyze({ document: tinyDocument, chunks: tinyChunks }),
    (error) => error.code === "AI_NO_EVIDENCE_CANDIDATES",
    "فشل آمن مشفر قبل أي اتصال",
  );
  assert.equal(fetchCalls, 0, "النموذج لا يُستدعى بلا مرشحين");
});

test("M) عدم التراجع: الثوابت والإصدارات المعتمدة في v2", () => {
  assert.equal(analysisReportSchemaVersion, "analysis-report-v2");
  assert.equal(analysisPromptVersion, "p4a-prompt-v4");
  assert.equal(modelSelectionSchemaVersion, "analysis-model-selection-v2");
  assert.equal(analysisFindingFields.length, 12);
  assert.deepEqual(evidenceCandidateLimits, { maxCandidates: 48, maxTotalExcerptChars: 6_000, maxExcerptChars: 400, minExcerptChars: 8 });
});

test("N) P4-M0BR0: معرف واحد ينتج statement حرفيًا وملخصًا مؤسسًا حتميًا", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-mat-detailed");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const [first, second] = catalog.candidates;

  // 1. اختيار معرف واحد ينتج statement مطابقاً حرفياً للدليل.
  const selectionSingle = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [first.candidateId] }],
    preliminaryDecision: "review",
    decisionEvidenceIds: [first.candidateId],
  };
  const reportSingle = materializeCanonicalReport(selectionSingle, catalog);
  assert.equal(reportSingle.scopeOfWork[0].statement, first.excerpt, "الدليل الفردي مطابق حرفياً");

  // 2. اختيار عدة معرفات ينتج نصاً حتمياً من مقاطع متصلة (concatenated excerpts) دون زيادة.
  const selectionMulti = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [first.candidateId, second.candidateId] }],
    preliminaryDecision: "review",
    decisionEvidenceIds: [first.candidateId],
  };
  const reportMulti = materializeCanonicalReport(selectionMulti, catalog);
  assert.equal(reportMulti.scopeOfWork[0].statement, `${first.excerpt}؛ ${second.excerpt}`, "الدليل المتعدد مدمج بفاصل حتمي");

  // 3. الملخص حتمي ومؤسس بالكامل: كل كلمة فيه من مقتطفات الأدلة المختارة نفسها.
  const wordsInSummary = reportMulti.executiveSummary
    .split(/\s+/)
    .map(w => w.replace(/[؛،:?؟.()[\]]/g, "").trim())
    .filter(w => w.length > 0);
  const corpus = new Set(
    `${first.excerpt} ${second.excerpt}`
      .split(/\s+/)
      .map(w => w.replace(/[؛،:?؟.()[\]]/g, "").trim())
      .filter(w => w.length > 0)
  );
  for (const word of wordsInSummary) {
    assert.ok(corpus.has(word), `الملخص يحتوي كلمة غير موجودة في مقتطفات الأدلة المختارة: ${word}`);
  }
  // لا كلمة «مبدئي» ولا «حسم» ولا أي كلمة من خارج الأدلة — لا fallback.
  assert.ok(!reportMulti.executiveSummary.includes("مبدئي"), "لا ملخص مبدئي غير مؤسس");
  assert.ok(!reportMulti.executiveSummary.includes("دون حسم"), "لا عبارة fallback");
  // warnings فارغة دائمًا: لا تحذيرات تشغيلية غير مؤسسة.
  assert.deepEqual(reportMulti.warnings, [], "warnings فارغة — لا تحذيرات غير مؤسسة");

  // 4. التقرير يجتاز validateAnalysisReport وverifyReportGrounding.
  assert.deepEqual(validateAnalysisReport(reportMulti), [], "التقرير متعدد الأدلة صالح بنيوياً");
  assert.equal(verifyReportGrounding(reportMulti, document, chunks), true, "التقرير متعدد الأدلة مجتاز للـ grounding");
  // والملخص نفسه مؤسس: مساوٍ حرفيًا لبنود findings (مقتطفات الأدلة) نفسها.
  const allFindingStatements = analysisFindingFields.flatMap((field) =>
    reportMulti[field].map((finding) => finding.statement));
  assert.ok(
    reportMulti.executiveSummary.split("؛ ").every((piece) => allFindingStatements.some((statement) => statement.includes(piece))),
    "الملخص مبني حصراً من بنود findings نفسها",
  );
});

test("O) P4-M0BR0: تغطية الفئات الاثنتي عشرة وحتمية الملخص الكامل", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-mat-all");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const first = catalog.candidates[0];
  const selectionAll = {
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: [first.candidateId],
    ...Object.fromEntries(analysisFindingFields.map((field) => [
      field,
      [{ severity: "info", confidence: "medium", evidenceIds: [first.candidateId] }]
    ]))
  };
  const reportAll = materializeCanonicalReport(selectionAll, catalog);
  for (const field of analysisFindingFields) {
    assert.equal(reportAll[field].length, 1, `الفئة ${field} مادية بنجاح`);
    assert.equal(reportAll[field][0].statement, first.excerpt, `الفئة ${field} statement حرفي`);
  }
  // الملخص الكامل: البند نفسه مكررًا عبر الفئات يُدمج مرة واحدة (Set) حتميًا.
  assert.equal(reportAll.executiveSummary, first.excerpt, "الملخص الكامل = البند الحرفي الوحيد (تكرار مُدمج)");
  assert.deepEqual(validateAnalysisReport(reportAll), [], "التقرير الكامل صالح");
  assert.equal(verifyReportGrounding(reportAll, document, chunks), true, "التقرير الكامل مجتاز للـ grounding");
});

test("P) P4-M0BR0: لا laundering ولا نصوص حرة — أمثلة Qwen تُرفض فورًا", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-qwen");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const first = catalog.candidates[0];

  // أمثلة Qwen الفاشلة نصيًا: كلمات واقعية حرة غير موجودة في corpus الأدلة.
  const qwenExamples = [
    { label: "statement زائد", mutate: (sel) => ({ ...sel, scopeOfWork: [{ statement: "يتعلق المشروع بتنفيذ أعمال صيانة لمبنى تدريبي في مدينة افتراضية", severity: "info", confidence: "low", evidenceIds: [first.candidateId] }] }) },
    { label: "executiveSummary زائد", mutate: (sel) => ({ ...sel, executiveSummary: "المستند يحتوي على معلومات صيانة مبنى تدريبي ويجب تحديد قيمة الضمان الابتدائي" }) },
    { label: "warnings زائدة", mutate: (sel) => ({ ...sel, warnings: ["يجب تحديد قيمة الضمان الابتدائي"] }) },
    { label: "category زائدة داخل الفئة", mutate: (sel) => ({ ...sel, scopeOfWork: [{ category: "scopeOfWork", severity: "info", confidence: "low", evidenceIds: [first.candidateId] }] }) },
    { label: "excerpt زائدة داخل الفئة", mutate: (sel) => ({ ...sel, scopeOfWork: [{ excerpt: "مقتطف منسوخ", severity: "info", confidence: "low", evidenceIds: [first.candidateId] }] }) },
    { label: "evidence objects زائدة", mutate: (sel) => ({ ...sel, evidence: [{ evidenceId: "ev-1", documentId: "d", sourceType: "pdf", excerpt: "مختلق", chunkId: "c" }] }) },
    { label: "حقل متداخل زائد", mutate: (sel) => ({ ...sel, scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: [first.candidateId], nested: { extra: true } }] }) },
  ];
  for (const { label, mutate } of qwenExamples) {
    const base = {
      ...emptySelection(),
      preliminaryDecision: "review",
      decisionEvidenceIds: [first.candidateId],
    };
    const tampered = mutate(base);
    const errors = validateModelSelection(tampered, catalog.candidates);
    assert.ok(Array.isArray(errors) && errors.length > 0, `${label}: مرفوض من المدقق`);
    assert.throws(
      () => materializeCanonicalReport(tampered, catalog),
      (err) => err.code === "AI_OUTPUT_INVALID" && !(err instanceof TypeError),
      `${label}: materialize يرفض بـAI_OUTPUT_INVALID`,
    );
  }

  // أمثلة Qwen الحرة صراحةً لا تدخل التقرير canonical أبدًا.
  for (const freeText of ["يتعلق المشروع", "المستند يحتوي", "يجب تحديد"]) {
    const tampered = {
      ...emptySelection(),
      preliminaryDecision: "review",
      decisionEvidenceIds: [first.candidateId],
      executiveSummary: `${freeText} نص حر`,
    };
    assert.throws(
      () => materializeCanonicalReport(tampered, catalog),
      (err) => err.code === "AI_OUTPUT_INVALID",
      `النص الحر «${freeText}» مرفوض`,
    );
  }
});

test("Q) P4-M0BR0: معرف مجهول أو مكرر يرفض، وبلا بنود مختارة يفشل الاختيار بأمان", () => {
  const { document, chunks } = fixtureDocument("booklet-pdf", "booklet-sample.pdf", "doc-no-selection");
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const first = catalog.candidates[0];

  // candidateId مجهول يرفض.
  const unknown = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: ["cand-000000000000000000000000"] }],
    preliminaryDecision: "review",
    decisionEvidenceIds: [first.candidateId],
  };
  assert.throws(() => materializeCanonicalReport(unknown, catalog), (err) => err.code === "AI_OUTPUT_INVALID");

  // candidateId مكرر داخل finding يرفض.
  const duplicated = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "low", evidenceIds: [first.candidateId, first.candidateId] }],
    preliminaryDecision: "review",
    decisionEvidenceIds: [first.candidateId],
  };
  assert.throws(() => materializeCanonicalReport(duplicated, catalog), (err) => err.code === "AI_OUTPUT_INVALID");

  // بلا بنود مختارة (كل الفئات فارغة) وinsufficient_data: لا fallback — فشل آمن مشفر.
  const noSelection = {
    ...emptySelection(),
    preliminaryDecision: "insufficient_data",
    confidence: "low",
    decisionEvidenceIds: [],
  };
  assert.throws(
    () => materializeCanonicalReport(noSelection, catalog),
    (err) => err.code === "AI_NO_GROUNDED_SELECTION" && !(err instanceof TypeError),
    "بلا بنود مؤسسة لا يُحفظ أي ملخص غير مؤسس",
  );
  // والمزود يمرر الكود نفسه ولا يُنتج تقريرًا.
  let generateCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => {
      generateCalls += 1;
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(noSelection) }) };
    },
  });
  return provider.analyze({ document, chunks }).then(
    () => { throw new Error("يجب أن يفشل"); },
    (error) => {
      assert.equal(error.code, "AI_NO_GROUNDED_SELECTION", "المزود يفشل بأمان بنفس الكود");
      assert.equal(generateCalls, 1, "محاولة واحدة");
    },
  );
});
