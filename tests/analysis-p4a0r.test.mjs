// اختبارات P4-A0R: تشديد أساس التحليل المحلي بعد المراجعة.
// fixtures ومحاكاة محلية فقط: بلا Chrome، بلا اعتماد، بلا شبكة، وبلا Ollama حي.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { extractAnalysisDocument, readZipEntries } from "../scripts/lib/analysis-documents.mjs";
import { chunkAnalysisDocument } from "../scripts/lib/analysis-chunking.mjs";
import {
  emptyAnalysisReport,
  normalizeReportEvidenceIds,
  validateAnalysisReport,
  verifyReportGrounding,
} from "../scripts/lib/analysis-report.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";
import { readJsonBodyLimited } from "../scripts/lib/http-body.mjs";
import { buildFixtureBuffers, buildZip } from "./helpers/analysis-fixture-factory.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));
const fixtureBuffers = buildFixtureBuffers();
const ollamaEnv = { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" };

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4a0r-"));
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

// مزود Ollama مزيف يبني اختيارًا بالمعرف من كتالوج الـprompt نفسه (P4-A1D0).
function groundedFakeFetch(calls) {
  return async (url, options) => {
    calls.push(url);
    const prompt = JSON.parse(options.body).prompt;
    const candidateId = prompt.match(/\[(cand-[0-9a-f]{24})\]/)[1];
    const selection = {
      ...emptyAnalysisReport(),
      preliminaryDecision: "review",
      confidence: "medium",
      decisionEvidenceIds: [candidateId],
    };
    delete selection.evidence; // مخطط الاختيار الداخلي لا يحتوي evidence (P4-A1D0)
    return { ok: true, json: async () => ({ response: JSON.stringify(selection) }) };
  };
}

test("R1) start-radar.mjs and the service agree on the exact service version", async () => {
  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  const starter = await readFile(new URL("../scripts/start-radar.mjs", import.meta.url), "utf8");
  const serviceVersion = service.match(/const serviceVersion = "([^"]+)"/)?.[1];
  const expected = starter.match(/const expectedServiceVersion = "([^"]+)"/)?.[1];
  assert.ok(serviceVersion, "service version found");
  assert.equal(expected, serviceVersion, "the launcher refuses stale services of the same build only");
  assert.equal(serviceVersion, "p4a-local-analysis-1");
});

test("R2) evidence ids are namespaced per job — two runs of the same fixture never collide", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository, { RADAR_AI_ENABLED: "false", RADAR_AI_PROVIDER: "stub" });
    const firstJob = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    const secondJob = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    const first = await engine.runJob(firstJob.id);
    const second = await engine.runJob(secondJob.id);
    assert.equal(first.jobStatus, "completed");
    assert.equal(second.jobStatus, "completed", "no primary-key collision on analysis_evidence");
    const firstIds = new Set(first.report.evidence.map((item) => item.evidenceId));
    assert.ok(firstIds.size > 0);
    for (const item of second.report.evidence) {
      assert.ok(!firstIds.has(item.evidenceId), `evidence id ${item.evidenceId} is unique across jobs`);
      assert.match(item.evidenceId, /^ev-[a-zA-Z0-9]+-\d+$/, "evidence ids carry the job scope");
    }
    // المراجع داخل findings وdecisionEvidenceIds أُعيدت كتابتها إلى المعرفات الجديدة.
    const secondIds = new Set(second.report.evidence.map((item) => item.evidenceId));
    for (const finding of second.findings) {
      for (const id of finding.evidenceIds) assert.ok(secondIds.has(id), "finding references remapped ids");
    }
    for (const id of second.report.decisionEvidenceIds) assert.ok(secondIds.has(id));
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("R3) concurrent runs: the atomic claim lets exactly one runner reach the provider", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const calls = [];
    const engine = engineWith(repository, ollamaEnv, { fetchFn: groundedFakeFetch(calls) });
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    const results = await Promise.allSettled([engine.runJob(job.id), engine.runJob(job.id)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one runner completes");
    assert.equal(fulfilled[0].value.jobStatus, "completed");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "ANALYSIS_JOB_NOT_RUNNABLE", "the loser is rejected before any provider work");
    assert.equal(calls.length, 1, "the provider is called exactly once — never twice for one job");
    const stored = engine.getJob(job.id);
    assert.equal(stored.modelRuns.length, 1, "a single model run is recorded");
    assert.equal(stored.modelRuns[0].status, "succeeded");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("R4) grounding: fabricated excerpts, foreign documents, and unknown chunks fail the job", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    // P4-A1D0: النموذج لا يكتب evidence أصلًا — محاولة إرسال أدلة مختلقة (حقل evidence
    // زائد ومعرفات غير مرشحة) تُرفض أبكر عند مدقق الاختيار بـAI_OUTPUT_INVALID،
    // قبل أن تصل إلى grounding إطلاقًا. الحاجز الأمني نفسه باقٍ وأقوى.
    const fabricated = async () => ({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          ...emptyAnalysisReport(),
          evidence: [{ evidenceId: "ev-1", documentId: "doc-foreign", sourceType: "pdf", pageNumber: 1, excerpt: "مقتطف مختلق لا وجود له في النص", chunkId: "chk-0000000000000000" }],
          decisionEvidenceIds: ["ev-1"],
          preliminaryDecision: "review",
          confidence: "medium",
        }),
      }),
    });
    const engine = engineWith(repository, ollamaEnv, { fetchFn: fabricated });
    const job = await engine.createJob({ fixtureId: "fixture-booklet-pdf" });
    await assert.rejects(() => engine.runJob(job.id), (error) => error.code === "AI_OUTPUT_INVALID");
    const failed = engine.getJob(job.id);
    assert.equal(failed.jobStatus, "failed");
    assert.equal(failed.errorCode, "AI_OUTPUT_INVALID", "fabricated evidence is rejected at selection validation, before grounding");
    assert.equal(failed.report, null, "no fabricated report is stored");
    assert.equal(failed.modelRuns[0].status, "failed");
  } finally {
    await cleanup(projectRoot, repository);
  }

  // وحدة الفحص مباشرة: مقتطف صحيح الشكل لكنه ليس جزءًا من نص الجزء.
  const document = extractAnalysisDocument({ documentId: "doc-ground", fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"] });
  const chunks = chunkAnalysisDocument(document);
  const base = { evidenceId: "ev-1", documentId: "doc-ground", sourceType: "pdf", pageNumber: 1, chunkId: chunks[0].chunkId };
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...base, excerpt: "نص غير موجود إطلاقًا" }] }, document, chunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED",
  );
  assert.throws(
    () => verifyReportGrounding({ evidence: [{ ...base, excerpt: chunks[0].text.split("\n")[0], pageNumber: 99 }] }, document, chunks),
    (error) => error.code === "ANALYSIS_GROUNDING_FAILED",
    "a location outside the chunk sources is rejected",
  );
  assert.equal(
    verifyReportGrounding({ evidence: [{ ...base, excerpt: chunks[0].text.split("\n")[0] }] }, document, chunks),
    true,
    "a verbatim excerpt from the chunk passes",
  );
});

test("R5) decisionEvidenceIds are mandatory for final decisions and must resolve", () => {
  const evidence = [{ evidenceId: "ev-1", documentId: "d", sourceType: "pdf", pageNumber: 1, excerpt: "نص", chunkId: "chk-1" }];
  const base = { ...emptyAnalysisReport(), evidence, confidence: "medium" };
  for (const decision of ["enter", "review", "exclude"]) {
    const missing = validateAnalysisReport({ ...base, preliminaryDecision: decision, decisionEvidenceIds: [] });
    assert.ok(missing.some((line) => line.includes("decisionEvidenceIds")), `${decision} without decision evidence is rejected`);
  }
  const dangling = validateAnalysisReport({ ...base, preliminaryDecision: "review", decisionEvidenceIds: ["ev-404"] });
  assert.ok(dangling.some((line) => line.includes("ev-404")), "dangling decision evidence is rejected");
  assert.deepEqual(validateAnalysisReport({ ...base, preliminaryDecision: "review", decisionEvidenceIds: ["ev-1"] }), [], "resolved decision evidence passes");
  assert.deepEqual(validateAnalysisReport({ ...emptyAnalysisReport(), preliminaryDecision: "insufficient_data", decisionEvidenceIds: [] }), [], "insufficient_data needs none");

  // التطبيع يعيد كتابة المراجع المعروفة ويُبقي الوهمية ليسقطها المدقق.
  const report = {
    ...base,
    preliminaryDecision: "review",
    decisionEvidenceIds: ["ev-1"],
    contractualRisks: [{ category: "contractualRisks", statement: "خطر", severity: "low", confidence: "low", evidenceIds: ["ev-1"] }],
  };
  const normalized = normalizeReportEvidenceIds(report, "analysis-job-abcdef123456");
  assert.equal(normalized.evidence[0].evidenceId, "ev-abcdef123456-1");
  assert.deepEqual(normalized.decisionEvidenceIds, ["ev-abcdef123456-1"]);
  assert.deepEqual(normalized.contractualRisks[0].evidenceIds, ["ev-abcdef123456-1"]);
  const phantom = normalizeReportEvidenceIds({ ...report, decisionEvidenceIds: ["ev-404"] }, "analysis-job-abcdef123456");
  assert.ok(validateAnalysisReport(phantom).some((line) => line.includes("ev-404")), "phantom references stay visible and rejected");
});

test("R6) maxChars is a hard guarantee: oversized paragraphs and tables split safely", () => {
  const longParagraph = Array.from({ length: 400 }, (_, index) => `كلمة${index}`).join(" ");
  const document = {
    documentId: "doc-long",
    blocks: [{ blockId: "b1", kind: "paragraph", text: longParagraph, source: { section: "قسم الاختبار" } }],
  };
  const chunks = chunkAnalysisDocument(document, { maxChars: 200, overlapChars: 20 });
  assert.ok(chunks.length > 5, "a huge paragraph becomes many chunks");
  assert.ok(chunks.every((chunk) => chunk.charCount <= 200), "no chunk ever exceeds maxChars");
  assert.ok(chunks.every((chunk) => chunk.sources[0].section === "قسم الاختبار"), "split parts keep their source");
  assert.ok(chunks.some((chunk) => chunk.blockIds.some((id) => id.includes("#p"))), "split parts are labeled");

  // جدول أكبر من الحد: كل صف عنصر مستقل، والترويسة تُلصق كسياق في الأجزاء اللاحقة.
  const header = "البند | الوصف | الوحدة | الكمية";
  const rows = Array.from({ length: 20 }, (_, index) => `${index + 1} | بند اختبار طويل نسبيًا لقياس التقسيم | قطعة | ${(index + 1) * 7}`);
  const tableDocument = {
    documentId: "doc-table",
    blocks: [header, ...rows].map((text, index) => ({
      blockId: `t1-r${index + 1}`, kind: "table-row", text, source: { section: "قسم الجداول" }, tableId: "tbl-1",
    })),
  };
  const tableChunks = chunkAnalysisDocument(tableDocument, { maxChars: 160, overlapChars: 0 });
  assert.ok(tableChunks.length > 1, "a large table spans multiple chunks");
  assert.ok(tableChunks.every((chunk) => chunk.charCount <= 160), "table chunks respect maxChars");
  for (const chunk of tableChunks.slice(1)) {
    assert.ok(chunk.text.includes(header), "continuation chunks carry the table header as context");
  }

  // العنوان يلتصق بما يليه ضمن الحد.
  const headed = {
    documentId: "doc-headed",
    blocks: [
      { blockId: "h1", kind: "heading", text: "عنوان القسم", source: { section: "عنوان القسم" } },
      { blockId: "p1", kind: "paragraph", text: "محتوى يلي العنوان مباشرة ويجب أن يلتصق به.", source: { section: "عنوان القسم" } },
    ],
  };
  const headedChunks = chunkAnalysisDocument(headed, { maxChars: 100, overlapChars: 0 });
  assert.equal(headedChunks.length, 1);
  assert.ok(headedChunks[0].text.includes("عنوان القسم") && headedChunks[0].text.includes("محتوى يلي العنوان"));
});

test("R7) ZIP hardening: truncation, corrupt offsets, bombs, and entry floods are rejected", () => {
  const valid = fixtureBuffers["boq-xlsx"];
  assert.ok(readZipEntries(valid).has("xl/workbook.xml"), "a valid archive still reads");

  assert.throws(() => readZipEntries(valid.subarray(0, valid.length - 120)), (error) => error.code === "DOCUMENT_CORRUPT", "truncated archive");
  const corruptOffset = Buffer.from(valid);
  const eocdOffset = corruptOffset.length - 22;
  assert.equal(corruptOffset.readUInt32LE(eocdOffset), 0x06054b50, "EOCD located at the tail");
  corruptOffset.writeUInt32LE(0x00ffffff, eocdOffset + 16); // central directory far outside the file
  assert.throws(() => readZipEntries(corruptOffset), (error) => error.code === "DOCUMENT_CORRUPT", "out-of-range central directory");

  // قنبلة ضغط مصطنعة: 2 م.ب أصفار تنضغط إلى بضعة ك.ب — نسبة تضخم ~1000.
  const bomb = buildZip([{ name: "bomb.bin", data: Buffer.alloc(2 * 1024 * 1024) }]);
  assert.throws(() => readZipEntries(bomb), (error) => error.code === "DOCUMENT_TOO_LARGE", "compression bomb rejected before inflate");

  const flood = buildZip(Array.from({ length: 65 }, (_, index) => ({ name: `f${index}.txt`, data: "x" })));
  assert.throws(() => readZipEntries(flood), (error) => error.code === "DOCUMENT_CORRUPT", "more than 64 entries rejected");
});

function pdfHex(text) {
  const be = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) be.writeUInt16BE(text.charCodeAt(index), index * 2);
  return `<${Buffer.concat([Buffer.from([0xfe, 0xff]), be]).toString("hex").toUpperCase()}>`;
}

// PDF قياسي: تدفق مضغوط zlib-wrapped مع /Filter /FlateDecode.
function buildFlatePdf(lines) {
  const textOps = lines.map((line, index) => `BT /F1 12 Tf 50 ${800 - index * 20} Td ${pdfHex(line)} Tj ET`).join("\n");
  const compressed = deflateSync(Buffer.from(textOps, "utf8")).toString("latin1");
  const objects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed}\nendstream`],
    [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
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

test("R8) PDF pages compressed with standard zlib FlateDecode extract correctly", () => {
  const buffer = buildFlatePdf(["سطر أول مضغوط", "سطر ثان مضغوط"]);
  const document = extractAnalysisDocument({ documentId: "doc-flate", fileName: "flate.pdf", buffer });
  assert.equal(document.blocks[0].text, "سطر أول مضغوط");
  assert.equal(document.blocks[1].text, "سطر ثان مضغوط");
  assert.deepEqual(document.warnings, [], "no decompression warnings for standard streams");
});

test("R9) JSON bodies are capped at 64KB with a 413 mapping", async () => {
  async function* bigRequest() {
    yield Buffer.alloc(40 * 1024);
    yield Buffer.alloc(40 * 1024);
  }
  await assert.rejects(() => readJsonBodyLimited(bigRequest()), (error) => error.code === "REQUEST_BODY_TOO_LARGE");
  async function* smallRequest() {
    yield Buffer.from('{"ok":true}');
  }
  assert.deepEqual(await readJsonBodyLimited(smallRequest()), { ok: true });
  async function* emptyRequest() { /* no chunks */ }
  assert.deepEqual(await readJsonBodyLimited(emptyRequest()), {});

  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  assert.match(service, /readJsonBodyLimited/, "the service uses the limited reader everywhere");
  assert.match(service, /REQUEST_BODY_TOO_LARGE" \? 413/, "oversized bodies map to 413");
  assert.doesNotMatch(service, /async function readJsonBody\(/, "no unbounded local reader remains");
});

test("R10) Ollama health has honest states and probes /api/tags only on demand", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    assert.equal((await engineWith(repository, {}).health({ probe: true })).status, "stub", "stub never probes");
    assert.equal((await engineWith(repository, { RADAR_AI_PROVIDER: "ollama", RADAR_AI_ENABLED: "false" }).health({ probe: true })).status, "disabled");
    const probeUrls = [];
    const tagsWithModel = async (url) => { probeUrls.push(url); return { ok: true, json: async () => ({ models: [{ name: "qwen2.5:7b" }] }) }; };
    const available = engineWith(repository, ollamaEnv, { fetchFn: tagsWithModel });
    assert.equal((await available.health()).status, "configured-unverified", "no probe without an explicit request");
    assert.equal(probeUrls.length, 0);
    assert.equal((await available.health({ probe: true })).status, "available", "the configured model is installed");
    assert.deepEqual(probeUrls, ["http://127.0.0.1:11434/api/tags"], "the probe touches /api/tags only");
    const down = engineWith(repository, ollamaEnv, { fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
    assert.equal((await down.health({ probe: true })).status, "unavailable");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("R11) .gitattributes protects binary fixtures and markdown line endings", async () => {
  const rootAttrs = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  for (const pattern of ["*.pdf binary", "*.xlsx binary", "*.docx binary", "*.md text eol=lf"]) {
    assert.ok(rootAttrs.includes(pattern), `root .gitattributes carries: ${pattern}`);
  }
  const fixtureAttrs = await readFile(new URL("../analysis-fixtures/.gitattributes", import.meta.url), "utf8");
  assert.doesNotMatch(fixtureAttrs, /^\* binary/m, "no bare wildcard that would conflict with *.md text");
  assert.match(fixtureAttrs, /\*\.pdf binary/);
});
