// اختبارات P4-A0R2: تشديد ثانٍ لأساس التحليل المحلي — صيغة v2، طلب Ollama
// الموثق، فحص النموذج الفعلي، نزاهة الأدلة، وحدود ZIP/PDF الإضافية.
// fixtures ومحاكاة محلية فقط: بلا Chrome، بلا اعتماد، بلا شبكة، وبلا Ollama حي.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { extractAnalysisDocument, readZipEntries } from "../scripts/lib/analysis-documents.mjs";
import { chunkAnalysisDocument } from "../scripts/lib/analysis-chunking.mjs";
import {
  analysisFindingFields,
  analysisPromptVersion,
  analysisReportSchemaVersion,
  emptyAnalysisReport,
  normalizeReportEvidenceIds,
  validateAnalysisReport,
  verifyReportGrounding,
} from "../scripts/lib/analysis-report.mjs";
import { buildEvidenceCandidateCatalog } from "../scripts/lib/analysis-evidence-candidates.mjs";
import { buildModelSelectionSchema } from "../scripts/lib/analysis-model-selection.mjs";
import { createOllamaProvider } from "../scripts/lib/analysis-providers.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";
import { buildFixtureBuffers, buildZip } from "./helpers/analysis-fixture-factory.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));
const fixtureBuffers = buildFixtureBuffers();
const ollamaEnv = { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" };

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4a0r2-"));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

async function cleanup(projectRoot, repository) {
  repository?.close();
  await rm(projectRoot, { recursive: true, force: true });
}

function engineWith(repository, env = {}, extra = {}) {
  return createAnalysisEngine({ repository, fixtureRoot, env, ...extra });
}

function pdfHex(text) {
  const be = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) be.writeUInt16BE(text.charCodeAt(index), index * 2);
  return `<${Buffer.concat([Buffer.from([0xfe, 0xff]), be]).toString("hex").toUpperCase()}>`;
}

// PDF متعدد الصفحات بتدفقات zlib-wrapped قياسية (/Filter /FlateDecode).
function buildFlatePdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const textOps = lines.map((line, lineIndex) => `BT /F1 12 Tf 50 ${800 - lineIndex * 20} Td ${pdfHex(line)} Tj ET`).join("\n");
    const compressed = deflateSync(Buffer.from(textOps, "utf8")).toString("latin1");
    objects.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`]);
    objects.push([contentId, `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed}\nendstream`]);
  });
  objects.push([3 + pages.length * 2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  let output = "%PDF-1.4\n";
  const offsets = [];
  for (const [id, body] of objects) {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

test("S1) report schema and prompt versions are v2 with twelve finding categories", () => {
  assert.equal(analysisReportSchemaVersion, "analysis-report-v3");
  assert.equal(analysisPromptVersion, "p4a-prompt-v5");
  for (const field of ["scopeOfWork", "boqSummary", "criticalQuantities"]) {
    assert.ok(analysisFindingFields.includes(field), `${field} is an evidence-backed finding category`);
  }
  assert.equal(analysisFindingFields.length, 12);
  const report = emptyAnalysisReport();
  assert.deepEqual(validateAnalysisReport(report), [], "empty v2 report stays valid with insufficient");
  for (const field of ["scopeOfWork", "boqSummary", "criticalQuantities"]) {
    const invalid = validateAnalysisReport({ ...report, [field]: ["نص حر بلا دليل"] });
    assert.ok(invalid.some((line) => line.includes(field)), `free text in ${field} is rejected`);
  }
});

test("S2) provider setup failure fails the job — never left extracting, never an untrusted call", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    let fetchCalls = 0;
    const engine = engineWith(repository, {
      RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://evil.example",
    }, { fetchFn: async () => { fetchCalls += 1; throw new Error("must not be called"); } });
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    await assert.rejects(() => engine.runJob(job.id), (error) => error.code === "AI_UNTRUSTED_HOST");
    const failed = engine.getJob(job.id);
    assert.equal(failed.jobStatus, "failed", "the job is failed, not stuck in extracting");
    assert.equal(failed.errorCode, "AI_UNTRUSTED_HOST");
    assert.ok(failed.finishedAt, "failure timestamp recorded");
    assert.equal(failed.modelRuns.length, 1);
    assert.equal(failed.modelRuns[0].status, "failed");
    assert.equal(failed.modelRuns[0].errorCode, "AI_UNTRUSTED_HOST");
    assert.equal(fetchCalls, 0, "no untrusted connection ever happens");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("S3) the Ollama request body itself: selection schema, source metadata, and full shape instructions", async () => {
  const document = extractAnalysisDocument({ documentId: "doc-req", fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"] });
  const chunks = chunkAnalysisDocument(document);
  // P4-A1D0: الاستجابة الصحيحة اختيار بالمعرف فقط من كتالوج المرشحين الحتمي.
  const catalog = buildEvidenceCandidateCatalog({ document, chunks });
  const validSelection = {
    ...emptyAnalysisReport(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [catalog.candidates[0].candidateId] }],
    evidenceSufficiency: "partial",
    confidence: "medium",
    sufficiencyEvidenceIds: [catalog.candidates[0].candidateId],
  };
  delete validSelection.evidence; // مخطط الاختيار الداخلي لا يحتوي evidence
  delete validSelection.executiveSummary; // P4-M0BR0: لا حقل نصي في المخطط الداخلي v2
  delete validSelection.warnings;
  let seenBody = null;
  const seenUrls = [];
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url, options) => { seenUrls.push(url); seenBody = JSON.parse(options.body); return { ok: true, json: async () => ({ response: JSON.stringify(validSelection) }) }; },
  });
  await provider.analyze({ document, chunks });

  assert.deepEqual(seenUrls, ["http://127.0.0.1:11434/api/generate"], "generate is the only endpoint");
  assert.equal(typeof seenBody.format, "object", "format is a schema object, not a plain string");
  assert.deepEqual(seenBody.format, JSON.parse(JSON.stringify(buildModelSelectionSchema(catalog.candidates))), "format carries the dynamic model-selection schema (P4-A1D0)");
  assert.ok(!("evidence" in seenBody.format.properties), "the model never sees an evidence field");
  assert.equal(seenBody.stream, false);
  const { prompt } = seenBody;
  assert.match(prompt, /sufficiencyEvidenceIds/, "decision evidence is requested explicitly");
  assert.match(prompt, /evidenceIds/, "finding shape with evidenceIds is documented");
  assert.match(prompt, /severity: info\|low\|medium\|high\|critical/, "finding shape is documented (v2 بلا statement/category)");
  assert.match(prompt, /لا تكتب أي نص أو statement/, "the model is forbidden from writing any free text");
  assert.doesNotMatch(prompt, /category, statement, severity/, "v2 لا يعرض حقل statement في شكل finding");
  assert.match(prompt, /analysis-model-selection-v3/, "the internal selection schema version is named");
  assert.doesNotMatch(prompt, /analysis-report-v3/, "النموذج لا يرى صيغة التقرير النهائية — يختار معرفات فقط");
  assert.match(prompt, /معرف المستند: doc-req/);
  for (const field of analysisFindingFields) assert.ok(prompt.includes(field), `prompt names category ${field}`);
  // كل مرشح يرسل بيانات مصدره الفعلية معه.
  const catalogHeaders = [...prompt.matchAll(/\[(cand-[0-9a-f]{24})\] sourceType=(\w+); ([^\n]+)/g)];
  assert.ok(catalogHeaders.length > 0, "candidates carry source metadata headers");
  assert.ok(catalogHeaders.every((match) => match[2] === "pdf"));
  assert.ok(catalogHeaders.some((match) => /pageNumber=1/.test(match[3])), "page numbers travel with candidates");
  assert.ok(prompt.length < 9_000, "still only the bounded catalog is sent");
});

test("S4) /api/tags decides availability by the installed model — never pulls", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const urls = [];
    const probe = (body) => async (url) => { urls.push(url); return { ok: true, json: async () => body }; };
    const byName = engineWith(repository, ollamaEnv, { fetchFn: probe({ models: [{ name: "nemotron-3.5-lightning:latest" }] }) });
    assert.equal((await byName.health({ probe: true })).status, "available", "models[].name detects the model");
    const byModel = engineWith(repository, ollamaEnv, { fetchFn: probe({ models: [{ model: "nemotron-3.5-lightning:latest" }] }) });
    assert.equal((await byModel.health({ probe: true })).status, "available", "models[].model detects the model");
    const missing = engineWith(repository, ollamaEnv, { fetchFn: probe({ models: [{ name: "llama3.1:8b" }] }) });
    assert.equal((await missing.health({ probe: true })).status, "model-unavailable", "service up but model absent");
    const empty = engineWith(repository, ollamaEnv, { fetchFn: probe({ models: [] }) });
    assert.equal((await empty.health({ probe: true })).status, "model-unavailable");
    const otherModel = engineWith(repository, { ...ollamaEnv, OLLAMA_MODEL: "qwen2.5:3b" }, { fetchFn: probe({ models: [{ name: "qwen2.5:7b" }] }) });
    assert.equal((await otherModel.health({ probe: true })).status, "model-unavailable", "only the configured model counts");
    assert.ok(urls.every((url) => url.endsWith("/api/tags")), "probes touch /api/tags only — never /api/pull");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("S5) stub findings for scope, BOQ, and quantities are evidence-backed end to end", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository, { RADAR_AI_ENABLED: "false", RADAR_AI_PROVIDER: "stub" });
    const pdfJob = await engine.runJob((await engine.createJob({ fixtureId: "fixture-booklet-pdf" })).id);
    assert.equal(pdfJob.jobStatus, "completed");
    const pdfEvidence = new Set(pdfJob.report.evidence.map((item) => item.evidenceId));
    assert.ok(pdfJob.report.scopeOfWork.length > 0, "scope of work extracted as findings");
    for (const finding of pdfJob.report.scopeOfWork) {
      assert.equal(typeof finding, "object");
      assert.match(finding.statement, /نطاق العمل/);
      for (const id of finding.evidenceIds) assert.ok(pdfEvidence.has(id), "scope finding cites stored evidence");
    }

    const boqJob = await engine.runJob((await engine.createJob({ fixtureId: "fixture-boq-xlsx" })).id);
    assert.equal(boqJob.jobStatus, "completed");
    const boqEvidence = new Set(boqJob.report.evidence.map((item) => item.evidenceId));
    assert.ok(boqJob.report.boqSummary.length > 0 && boqJob.report.criticalQuantities.length > 0);
    for (const finding of [...boqJob.report.boqSummary, ...boqJob.report.criticalQuantities]) {
      assert.ok(finding.evidenceIds.every((id) => boqEvidence.has(id)), "BOQ and quantity findings cite stored evidence");
    }
    assert.ok(boqJob.findings.some((finding) => finding.category === "boqSummary"), "BOQ findings persist in the database");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("S6) evidence integrity: sourceType and per-type location requirements", () => {
  const pdf = extractAnalysisDocument({ documentId: "doc-int-pdf", fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"] });
  const pdfChunks = chunkAnalysisDocument(pdf);
  const pdfBase = { evidenceId: "ev-1", documentId: "doc-int-pdf", pageNumber: 1, chunkId: pdfChunks[0].chunkId, excerpt: pdfChunks[0].text.split("\n")[0] };
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...pdfBase, sourceType: "docx" }] }, pdf, pdfChunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED" && /sourceType/.test(error.message),
    "a mismatched sourceType is rejected",
  );
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...pdfBase, sourceType: "pdf", pageNumber: undefined }] }, pdf, pdfChunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED",
    "PDF evidence without a page number is rejected",
  );
  assert.equal(verifyReportGrounding({ evidence: [{ ...pdfBase, sourceType: "pdf" }] }, pdf, pdfChunks), true, "well-formed PDF evidence passes");

  const xlsx = extractAnalysisDocument({ documentId: "doc-int-x", fileName: "boq-sample.xlsx", buffer: fixtureBuffers["boq-xlsx"] });
  const xlsxChunks = chunkAnalysisDocument(xlsx);
  const xlsxChunk = xlsxChunks.find((chunk) => chunk.sources.some((source) => source.sheetName === "جدول الكميات"));
  const xlsxSource = xlsxChunk.sources.find((source) => source.sheetName === "جدول الكميات");
  const xlsxBase = { evidenceId: "ev-1", documentId: "doc-int-x", sourceType: "xlsx", chunkId: xlsxChunk.chunkId, excerpt: xlsxChunk.text.split("\n")[0].slice(0, 30) };
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...xlsxBase, sheetName: "جدول الكميات" }] }, xlsx, xlsxChunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED",
    "XLSX evidence without cellRange is rejected",
  );
  assert.equal(
    verifyReportGrounding({ evidence: [{ ...xlsxBase, sheetName: xlsxSource.sheetName, cellRange: xlsxSource.cellRange }] }, xlsx, xlsxChunks),
    true,
    "XLSX evidence with sheet and range passes",
  );

  const docx = extractAnalysisDocument({ documentId: "doc-int-w", fileName: "conditions-sample.docx", buffer: fixtureBuffers["conditions-docx"] });
  const docxChunks = chunkAnalysisDocument(docx);
  const docxBase = { evidenceId: "ev-1", documentId: "doc-int-w", sourceType: "docx", chunkId: docxChunks[0].chunkId, excerpt: docxChunks[0].text.split("\n")[0].slice(0, 30) };
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...docxBase, section: undefined }] }, docx, docxChunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED",
    "DOCX evidence without a section is rejected",
  );
  assert.equal(
    verifyReportGrounding({ evidence: [{ ...docxBase, section: docxChunks[0].sources[0].section }] }, docx, docxChunks),
    true,
    "DOCX evidence with a section passes",
  );
});

test("S7) duplicate evidence ids inside one report are rejected before normalization", () => {
  const evidenceItem = { evidenceId: "ev-1", documentId: "d", sourceType: "pdf", pageNumber: 1, excerpt: "نص", chunkId: "chk-1" };
  const report = { ...emptyAnalysisReport(), evidence: [evidenceItem, { ...evidenceItem }] };
  assert.throws(
    () => normalizeReportEvidenceIds(report, "analysis-job-abcdef123456"),
    (error) => error.code === "ANALYSIS_OUTPUT_INVALID" && /مكرر/.test(error.message),
    "duplicates never reach the database",
  );
});

test("S8) ZIP extras: false declared sizes, duplicate names, and actual-size totals", () => {
  const valid = fixtureBuffers["boq-xlsx"];
  assert.ok(readZipEntries(valid).has("xl/workbook.xml"), "valid archives still read");

  // حجم معلن كاذب: المخزن الفعلي سليم لكن الترويسة المركزية تدعي حجمًا مختلفًا.
  const lying = Buffer.from(buildZip([{ name: "x.txt", data: "hello" }]));
  const centralOffset = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > 0, "central header located");
  lying.writeUInt32LE(500, centralOffset + 24); // الحجم المعلن 500 والفعلي 5
  assert.throws(() => readZipEntries(lying), (error) => error.code === "DOCUMENT_CORRUPT", "a false declared size is rejected");

  const duplicate = buildZip([{ name: "a.txt", data: "x" }, { name: "a.txt", data: "y" }]);
  assert.throws(() => readZipEntries(duplicate), (error) => error.code === "DOCUMENT_CORRUPT", "duplicate member names are rejected");

  // الحد الإجمالي بالحجم الفعلي: عضوان 100 ك.ب فعليًا يتجاوزان حدًا إجماليًا 150 ك.ب.
  const twoMembers = buildZip([
    { name: "r1.bin", data: randomBytes(100 * 1024) },
    { name: "r2.bin", data: randomBytes(100 * 1024) },
  ]);
  assert.throws(
    () => readZipEntries(twoMembers, { maxTotalBytes: 150 * 1024 }),
    (error) => error.code === "DOCUMENT_TOO_LARGE",
    "the total limit uses actual decompressed sizes",
  );
  assert.ok(readZipEntries(twoMembers, { maxTotalBytes: 300 * 1024 }).size === 2, "within the limit it reads fine");
});

test("S9) inflated PDF streams are capped by maxOutputLength", () => {
  const hugeLine = "سطر ".repeat(2000);
  const buffer = buildFlatePdf([["صفحة أولى سليمة"], [hugeLine]]);
  const document = extractAnalysisDocument({ documentId: "doc-cap", fileName: "cap.pdf", buffer, maxStreamBytes: 4 * 1024 });
  assert.ok(document.blocks.some((block) => block.text === "صفحة أولى سليمة"), "the small page still extracts");
  assert.ok(document.warnings.some((warning) => /تعذر فك ضغط الصفحة 2/.test(warning)), "the oversized stream is capped and reported");
  assert.ok(!document.blocks.some((block) => block.source.pageNumber === 2), "no partial text from the capped stream");
  const uncapped = extractAnalysisDocument({ documentId: "doc-cap2", fileName: "cap.pdf", buffer });
  assert.ok(uncapped.blocks.some((block) => block.source.pageNumber === 2), "the default budget still reads the page");
});
