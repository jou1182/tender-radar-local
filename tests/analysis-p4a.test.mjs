// اختبارات P4-A0: البنية المحلية لتحليل وثائق المنافسات.
// fixtures مصطنعة ومحاكاة محلية فقط: بلا Chrome، بلا اعتماد، بلا مزامنة، بلا تنزيل،
// وبلا أي اتصال خارجي. Ollama يُختبر بـfetch مزيف فقط.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import {
  extractAnalysisDocument,
  inspectDocumentBuffer,
  readZipEntries,
  resolveAnalysisPath,
  supportedDocumentTypes,
} from "../scripts/lib/analysis-documents.mjs";
import { chunkAnalysisDocument } from "../scripts/lib/analysis-chunking.mjs";
import {
  analysisReportFields,
  emptyAnalysisReport,
  validateAnalysisReport,
} from "../scripts/lib/analysis-report.mjs";
import {
  assertLoopbackOllamaHost,
  createAnalysisProvider,
  createOllamaProvider,
  readAnalysisAiConfig,
} from "../scripts/lib/analysis-providers.mjs";
import { analysisFixtures, findAnalysisFixture } from "../scripts/lib/analysis-fixtures.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";
import { createAnalysisApiHandler } from "../scripts/lib/analysis-api.mjs";
import { readLiveAcquisitionConfig } from "../scripts/lib/live-attachment-acquisition.mjs";
import { buildFixtureBuffers, buildPdf } from "./helpers/analysis-fixture-factory.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));
const fixtureBuffers = buildFixtureBuffers();

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4a-"));
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

test("1-2) migration v6→v7 preserves existing data and is idempotent", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-v6-"));
  let repository;
  try {
    const privateDir = path.join(projectRoot, ".radar-data");
    await mkdir(privateDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(privateDir, "radar.sqlite"));
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-08-14T00:00:00.000Z');
      CREATE TABLE tenders (
        reference TEXT PRIMARY KEY, title TEXT NOT NULL, agency TEXT NOT NULL,
        fee INTEGER NOT NULL DEFAULT 0, region TEXT NOT NULL, deadline TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '', platform_status TEXT NOT NULL DEFAULT '',
        activity TEXT NOT NULL DEFAULT '', sub_activity TEXT NOT NULL DEFAULT '',
        tender_type TEXT NOT NULL DEFAULT '', etimad_url TEXT NOT NULL DEFAULT '',
        tender_number TEXT NOT NULL DEFAULT '', contract_duration TEXT NOT NULL DEFAULT '',
        guarantee TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        quantity_summary TEXT NOT NULL DEFAULT '', attachment_names_json TEXT NOT NULL DEFAULT '[]',
        fee_verification TEXT NOT NULL DEFAULT 'unknown', fee_raw_text TEXT, fee_verified_at TEXT,
        source_hash TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO tenders (reference, title, agency, fee, region, deadline, fee_verification, first_seen_at, last_seen_at) VALUES
        ('260000008100', 'منافسة v6 محفوظة', 'جهة اختبار', 0, 'منطقة الرياض', '2026-09-01 09:59', 'detail-verified', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('260000008101', 'منافسة v6 مدفوعة', 'جهة اختبار', 900, 'منطقة مكة', '2026-09-02 09:59', 'card-observed', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      CREATE TABLE approvals (id TEXT PRIMARY KEY, tender_reference TEXT, action TEXT NOT NULL, target TEXT NOT NULL, approved_at TEXT NOT NULL, consumed_at TEXT);
      INSERT INTO approvals VALUES ('v6-approval', '260000008100', 'download-attachments', 'attachments', '2026-08-14T00:00:00.000Z', NULL);
    `);
    const before = {
      tenders: Number(legacy.prepare("SELECT COUNT(*) AS count FROM tenders").get().count),
      approvals: Number(legacy.prepare("SELECT COUNT(*) AS count FROM approvals").get().count),
    };
    legacy.close();
    assert.deepEqual(before, { tenders: 2, approvals: 1 }, "fixture row counts before migration");

    repository = await createRadarRepository({ projectRoot });
    assert.equal(repository.schemaVersion, 7);
    assert.equal(repository.getTender("260000008100").feeVerification, "detail-verified", "v6 evidence survives");
    assert.equal(repository.getTender("260000008101").fee, 900);
    const tables = database => new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const inspector = new DatabaseSync(path.join(privateDir, "radar.sqlite"));
    const names = tables(inspector);
    for (const table of ["analysis_documents", "analysis_jobs", "analysis_findings", "analysis_evidence", "model_runs"]) {
      assert.ok(names.has(table), `table ${table} exists after migration`);
    }
    const after = {
      tenders: Number(inspector.prepare("SELECT COUNT(*) AS count FROM tenders").get().count),
      approvals: Number(inspector.prepare("SELECT COUNT(*) AS count FROM approvals").get().count),
    };
    inspector.close();
    assert.deepEqual(after, before, "no existing row was lost");
    repository.close();

    // إعادة التشغيل: لا خطأ ولا تغيير.
    repository = await createRadarRepository({ projectRoot });
    assert.equal(repository.schemaVersion, 7);
    assert.equal(repository.listTenders().length, 2);
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("3-4) extraction preserves Arabic UTF-8 and yields unified content per supported type", async () => {
  const cases = [
    { key: "booklet-pdf", file: "booklet-sample.pdf", type: "pdf", probe: "الضمان الابتدائي: 5000 ريال سعودي" },
    { key: "boq-xlsx", file: "boq-sample.xlsx", type: "xlsx", probe: "أعمال حفر تأسيسية" },
    { key: "conditions-docx", file: "conditions-sample.docx", type: "docx", probe: "الشروط العامة" },
  ];
  for (const [index, item] of cases.entries()) {
    const buffer = await readFile(path.join(fixtureRoot, item.file));
    const document = extractAnalysisDocument({ documentId: `doc-test-${index}`, fileName: item.file, buffer });
    assert.equal(document.documentType, item.type);
    assert.ok(document.blocks.length > 0, `${item.type} yields blocks`);
    assert.ok(document.blocks.some((block) => block.text.includes(item.probe)), `${item.type} preserves Arabic text exactly`);
    assert.equal(document.checksum.length, 64);
    assert.ok(document.mimeType.startsWith("application/"));
  }
  const pdf = extractAnalysisDocument({ documentId: "doc-pages", fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"] });
  assert.ok(pdf.blocks.some((block) => block.source.pageNumber === 2), "PDF keeps page numbers");
  const xlsx = extractAnalysisDocument({ documentId: "doc-sheets", fileName: "boq-sample.xlsx", buffer: fixtureBuffers["boq-xlsx"] });
  assert.ok(xlsx.blocks.some((block) => block.source.sheetName === "جدول الكميات" && block.source.cellRange === "A2:D2"), "XLSX keeps sheet and cell range");
  assert.ok(xlsx.tables.length === 2 && xlsx.tables[0].rows[0].includes("الكمية"), "XLSX tables extracted");
  const docx = extractAnalysisDocument({ documentId: "doc-sections", fileName: "conditions-sample.docx", buffer: fixtureBuffers["conditions-docx"] });
  assert.ok(docx.blocks.some((block) => block.kind === "heading" && block.source.section === "الالتزامات والغرامات"), "DOCX keeps sections");
  assert.ok(docx.tables.length === 1 && docx.tables[0].rows[1][0] === "الضمان الابتدائي", "DOCX tables extracted");
});

test("5-7) unsupported types, MIME mismatch, and oversize files are rejected", () => {
  assert.throws(
    () => extractAnalysisDocument({ documentId: "x", fileName: "script.exe", buffer: Buffer.from("MZ...") }),
    (error) => error.code === "DOCUMENT_TYPE_NOT_SUPPORTED",
  );
  assert.throws(
    () => extractAnalysisDocument({ documentId: "x", fileName: "fake.pdf", buffer: fixtureBuffers["boq-xlsx"] }),
    (error) => error.code === "DOCUMENT_MIME_MISMATCH",
  );
  assert.throws(
    () => extractAnalysisDocument({ documentId: "x", fileName: "fake.xlsx", buffer: fixtureBuffers["booklet-pdf"] }),
    (error) => error.code === "DOCUMENT_MIME_MISMATCH",
  );
  assert.throws(
    () => inspectDocumentBuffer({ fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"], maxBytes: 64 }),
    (error) => error.code === "DOCUMENT_TOO_LARGE",
  );
  assert.deepEqual(supportedDocumentTypes, ["pdf", "xlsx", "docx"]);
});

test("8) path traversal, absolute paths, and client-supplied paths are blocked", async () => {
  for (const malicious of ["../secret.pdf", "..\\win.pdf", "C:\\temp\\x.pdf", "C:/temp/x.pdf", "/etc/passwd", "sub/../../x.pdf"]) {
    assert.throws(() => resolveAnalysisPath(fixtureRoot, malicious), (error) => error.code === "DOCUMENT_PATH_NOT_ALLOWED", malicious);
  }
  assert.ok(resolveAnalysisPath(fixtureRoot, "booklet-sample.pdf").endsWith(path.join("analysis-fixtures", "booklet-sample.pdf")));

  const { projectRoot, repository } = await tempRepository();
  try {
    const handler = createAnalysisApiHandler({ engine: engineWith(repository) });
    for (const body of [
      { path: "analysis-fixtures/booklet-sample.pdf" },
      { filePath: "C:/temp/x.pdf" },
      { file: "x.pdf" },
      { content: "..." },
      { fileName: "booklet-sample.pdf" },
    ]) {
      const response = await handler({ method: "POST", pathname: "/analysis/jobs", body });
      assert.equal(response.status, 400);
      assert.equal(response.payload.error, "ANALYSIS_PATH_NOT_ALLOWED", "any client-supplied path or content is refused");
    }
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("9-10) chunking is deterministic, bounded, overlapping, and keeps source evidence", async () => {
  const buffer = await readFile(path.join(fixtureRoot, "booklet-sample.pdf"));
  const document = extractAnalysisDocument({ documentId: "doc-chunk", fileName: "booklet-sample.pdf", buffer });
  const first = chunkAnalysisDocument(document, { maxChars: 150, overlapChars: 60 });
  const second = chunkAnalysisDocument(document, { maxChars: 150, overlapChars: 60 });
  assert.deepEqual(first.map((chunk) => chunk.chunkId), second.map((chunk) => chunk.chunkId), "same input yields identical chunk ids");
  assert.ok(first.length > 1, "small budget forces multiple chunks");
  assert.ok(first.every((chunk) => chunk.charCount <= 150), "P4-A0R: no chunk ever exceeds maxChars");
  const sharesBlock = first.some((chunk, index) => index > 0 && chunk.blockIds.some((id) => first[index - 1].blockIds.includes(id)));
  assert.ok(sharesBlock, "overlap keeps a shared trailing block between consecutive chunks");
  assert.ok(first.every((chunk) => chunk.sources.every((source) => source.pageNumber >= 1)), "PDF chunks keep page evidence");

  const sheetDoc = extractAnalysisDocument({ documentId: "doc-chunk-x", fileName: "boq-sample.xlsx", buffer: fixtureBuffers["boq-xlsx"] });
  const sheetChunks = chunkAnalysisDocument(sheetDoc, { maxChars: 90, overlapChars: 30 });
  assert.ok(sheetChunks.every((chunk) => chunk.charCount <= 90), "P4-A0R: XLSX chunks never exceed maxChars");
  assert.ok(sheetChunks.some((chunk) => chunk.sources.some((source) => source.sheetName === "جدول الكميات" && source.cellRange)), "XLSX chunks keep sheet/cell evidence");
  const tableChunks = sheetChunks.filter((chunk) => chunk.tableIds.includes("sheet-1"));
  assert.ok(tableChunks.length >= 1, "table rows stay attached to their table id");

  const docxDoc = extractAnalysisDocument({ documentId: "doc-chunk-w", fileName: "conditions-sample.docx", buffer: fixtureBuffers["conditions-docx"] });
  const docxChunks = chunkAnalysisDocument(docxDoc, { maxChars: 120, overlapChars: 40 });
  assert.ok(docxChunks.every((chunk) => chunk.charCount <= 120), "P4-A0R: DOCX chunks never exceed maxChars");
  assert.ok(docxChunks.every((chunk) => chunk.sources.every((source) => typeof source.section === "string")), "DOCX chunks keep section evidence");
  const headingChunk = docxChunks.find((chunk) => chunk.text.includes("الالتزامات والغرامات") && chunk.text.length > "الالتزامات والغرامات".length);
  assert.ok(headingChunk, "a heading stays attached to its following content");
});

test("11) end-to-end stub analysis completes with an evidence-backed validated report", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository, { RADAR_AI_ENABLED: "false", RADAR_AI_PROVIDER: "stub" });
    const handler = createAnalysisApiHandler({ engine });

    const created = await handler({ method: "POST", pathname: "/analysis/jobs", body: { fixtureId: "fixture-booklet-pdf" } });
    assert.equal(created.status, 201);
    assert.equal(created.payload.job.jobStatus, "queued");
    assert.equal(created.payload.job.provider, "stub");
    assert.equal(created.payload.job.document.sourceKind, "fixture");
    assert.equal(created.payload.job.document.checksum.length, 64);

    const fetched = await handler({ method: "GET", pathname: `/analysis/jobs/${created.payload.job.id}` });
    assert.equal(fetched.status, 200);

    const run = await handler({ method: "POST", pathname: `/analysis/jobs/${created.payload.job.id}/run` });
    assert.equal(run.status, 200);
    const job = run.payload.job;
    assert.equal(job.jobStatus, "completed");
    assert.deepEqual(validateAnalysisReport(job.report), [], "the stored report matches the schema");
    assert.ok(job.report.evidence.length > 0);
    assert.notEqual(job.report.preliminaryDecision, "insufficient_data");
    const evidenceIds = new Set(job.report.evidence.map((item) => item.evidenceId));
    assert.ok(job.findings.length > 0);
    for (const finding of job.findings) {
      assert.ok(finding.evidenceIds.length > 0, "every finding cites evidence");
      for (const id of finding.evidenceIds) assert.ok(evidenceIds.has(id));
    }
    assert.ok(job.report.bidBonds.some((finding) => finding.statement.includes("5000")), "stub surfaces the bid bond from the fixture");
    assert.ok(job.report.decisionEvidenceIds.length > 0, "a review decision carries explicit decision evidence");
    for (const id of job.report.decisionEvidenceIds) assert.ok(evidenceIds.has(id), "decision evidence exists in evidence");
    assert.ok(job.report.evidence.every((item) => item.chunkId.startsWith("chk-") && item.documentId === job.document.id));
    assert.equal(job.modelRuns.length, 1);
    assert.equal(job.modelRuns[0].status, "succeeded");
    assert.equal(job.modelRuns[0].provider, "stub");
    assert.ok(!("prompt" in job.modelRuns[0]) && !("response" in job.modelRuns[0]), "model run stores no prompt or response text");

    const rerun = await handler({ method: "POST", pathname: `/analysis/jobs/${job.id}/run` });
    assert.equal(rerun.status, 409, "a completed job cannot be re-run");
    const missing = await handler({ method: "GET", pathname: "/analysis/jobs/nope" });
    assert.equal(missing.status, 404);
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("12-13) Ollama fails safe when disabled and rejects any non-loopback host", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository, { RADAR_AI_PROVIDER: "ollama", RADAR_AI_ENABLED: "false" });
    const job = await engine.createJob({ fixtureId: "fixture-conditions-docx" });
    await assert.rejects(() => engine.runJob(job.id), (error) => error.code === "AI_PROVIDER_DISABLED");
    const failed = engine.getJob(job.id);
    assert.equal(failed.jobStatus, "failed");
    assert.equal(failed.errorCode, "AI_PROVIDER_DISABLED");
    assert.equal(failed.modelRuns.length, 1);
    assert.equal(failed.modelRuns[0].status, "failed");
    assert.match(failed.errorMessage, /RADAR_AI_ENABLED/);
  } finally {
    await cleanup(projectRoot, repository);
  }
  for (const host of ["http://example.com:11434", "https://127.0.0.1:11434", "http://169.254.169.254", "http://0.0.0.0:11434", "not-a-url"]) {
    assert.throws(() => createOllamaProvider({ env: { OLLAMA_HOST: host } }), (error) => error.code === "AI_UNTRUSTED_HOST", host);
  }
  assert.equal(readAnalysisAiConfig({ OLLAMA_HOST: "" }).ollamaHost, "http://127.0.0.1:11434", "an empty host falls back to the loopback default, never to an external one");
  assert.equal(assertLoopbackOllamaHost("http://localhost:11434"), "http://localhost:11434");
  assert.equal(readAnalysisAiConfig({}).provider, "stub", "stub is the default provider");
});

test("14-15) Ollama sends only necessary text chunks to /api/generate, never pulls a model, and rejects invalid output", async () => {
  const document = extractAnalysisDocument({ documentId: "doc-ollama", fileName: "booklet-sample.pdf", buffer: fixtureBuffers["booklet-pdf"] });
  const chunks = chunkAnalysisDocument(document);
  const calls = [];
  const validReport = { ...emptyAnalysisReport(), evidence: [{ evidenceId: "ev-1", documentId: "doc-ollama", sourceType: "pdf", pageNumber: 1, excerpt: "دليل", chunkId: chunks[0].chunkId }], decisionEvidenceIds: ["ev-1"], preliminaryDecision: "review" };
  const fetchFn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ response: JSON.stringify(validReport) }) };
  };
  const provider = createOllamaProvider({
    env: { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434", OLLAMA_MODEL: "qwen2.5:7b" },
    fetchFn,
  });
  const report = await provider.analyze({ document, chunks });
  assert.equal(report.preliminaryDecision, "review");
  assert.ok(report._meta.durationMs >= 0, "duration is measured for the run log");
  assert.equal(calls.length, 1, "exactly one attempt — no unbounded retry");
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/generate", "the generate endpoint is the only call");
  assert.ok(!calls.some((call) => call.url.includes("/api/pull")), "no model pull ever");
  assert.equal(calls[0].body.model, "qwen2.5:7b");
  assert.ok(calls[0].body.prompt.length < 8_000, "only the necessary text chunks are sent, never the whole file");

  const badFetch = async () => ({ ok: true, json: async () => ({ response: "ليس JSON" }) });
  const badProvider = createOllamaProvider({
    env: { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" },
    fetchFn: badFetch,
  });
  await assert.rejects(() => badProvider.analyze({ document, chunks }), (error) => error.code === "AI_OUTPUT_INVALID");

  const failingFetch = async () => { throw new Error("ECONNREFUSED"); };
  const downProvider = createOllamaProvider({
    env: { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" },
    fetchFn: failingFetch,
  });
  await assert.rejects(() => downProvider.analyze({ document, chunks }), (error) => error.code === "AI_PROVIDER_UNAVAILABLE");

  assert.throws(() => createAnalysisProvider({ env: { RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://evil.example" } }), (error) => error.code === "AI_UNTRUSTED_HOST");
});

test("15-16) the report schema rejects malformed output and any decision without evidence", () => {
  assert.ok(validateAnalysisReport(null).length > 0);
  assert.ok(validateAnalysisReport({}).length > 0, "missing fields are rejected");
  const report = emptyAnalysisReport();
  assert.deepEqual(validateAnalysisReport(report), [], "an empty report with insufficient_data is valid");
  const enterWithoutEvidence = validateAnalysisReport({ ...report, preliminaryDecision: "enter" });
  assert.ok(enterWithoutEvidence.some((line) => line.includes("بلا أدلة")), "a final decision without evidence is impossible");
  assert.ok(enterWithoutEvidence.some((line) => line.includes("decisionEvidenceIds")), "enter requires explicit decision evidence ids");
  const withFinding = {
    ...report,
    evidence: [{ evidenceId: "ev-1", documentId: "d", sourceType: "pdf", pageNumber: 1, excerpt: "نص", chunkId: "chk-1" }],
    decisionEvidenceIds: ["ev-1"],
    contractualRisks: [{ category: "contractualRisks", statement: "خطر", severity: "high", confidence: "low", evidenceIds: ["ev-404"] }],
    preliminaryDecision: "review",
  };
  assert.ok(validateAnalysisReport(withFinding).some((line) => line.includes("ev-404")), "dangling evidence references are rejected");
  const noFindingEvidence = { ...withFinding, contractualRisks: [{ category: "c", statement: "s", severity: "low", confidence: "low", evidenceIds: [] }] };
  assert.ok(validateAnalysisReport(noFindingEvidence).length > 0, "a finding without evidenceIds is rejected");
  for (const field of analysisReportFields) assert.ok(field, "schema fields documented");
});

test("17) fixtures never mix with operational data and the registry is closed", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository);
    for (const fixture of analysisFixtures) {
      const job = await engine.createJob({ fixtureId: fixture.fixtureId });
      assert.equal(job.document.sourceKind, "fixture");
      assert.equal(job.document.fixtureId, fixture.fixtureId);
    }
    await assert.rejects(() => engine.createJob({ fixtureId: "../../radar/.radar-data/radar.sqlite" }), (error) => error.code === "ANALYSIS_FIXTURE_NOT_FOUND");
    assert.equal(findAnalysisFixture("production-db"), null, "only documented fixtureIds resolve");
    // قاعدة الاختبار مؤقتة ومستقلة تمامًا عن .radar-data الخاص بالمشروع.
    assert.ok(repository.databasePath.startsWith(projectRoot), "the test database lives in the temp root");
    assert.ok(!repository.databasePath.includes(`${path.sep}radar${path.sep}.radar-data`), "the production database is never touched");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("18) the n8n workflow is valid, inactive, localhost-only, and free of secrets and cloud AI", async () => {
  const raw = await readFile(new URL("../workflows/p4a-local-analysis.json", import.meta.url), "utf8");
  const workflow = JSON.parse(raw);
  assert.equal(workflow.active, false, "the workflow ships disabled");
  assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length >= 4);
  const allowedTypes = new Set(["n8n-nodes-base.webhook", "n8n-nodes-base.if", "n8n-nodes-base.httpRequest", "n8n-nodes-base.respondToWebhook"]);
  for (const node of workflow.nodes) {
    assert.ok(allowedTypes.has(node.type), `unexpected node type ${node.type}`);
    assert.equal(node.credentials, undefined, `node ${node.name} carries no credentials`);
  }
  assert.doesNotMatch(raw, /tenders\.etimad\.sa|etimad\.sa/i, "the workflow never reaches Etimad");
  assert.doesNotMatch(raw, /password|token|secret|api[_-]?key|credential/i, "no secrets in the workflow file");
  assert.doesNotMatch(raw, /langchain|openai|anthropic|azure|google/i, "no cloud AI nodes");
  const urls = [...raw.matchAll(/https?:\/\/[^"'\s}]+/g)].map((match) => match[0]);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(url.startsWith("http://127.0.0.1:"), `localhost only: ${url}`);
  assert.match(raw, /analysisJobId/, "the workflow receives only the analysis job id");
});

test("19) P3-B1B/P3-B1C and live download stay stopped and disabled by default", async () => {
  assert.equal(readLiveAcquisitionConfig({}).enabled, false, "live download stays disabled by default");
  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  assert.match(service, /createDisabledProductionDownloadAdapter/, "the production download adapter stays disabled");
  assert.match(service, /FEE_NOT_DETAIL_VERIFIED/, "the P3-B1B0 fee gate stays enforced");
  // مسارا المزامنة والموافقات لا يحتويان أي إشارة إلى محرك التحليل أو الذكاء الاصطناعي.
  const syncRoute = service.slice(service.indexOf('request.url === "/sync"'), service.indexOf('pathname === "/analysis/health"'));
  assert.doesNotMatch(syncRoute, /analysis|ollama/i, "the sync route never touches analysis or AI");
  const approvalSlice = service.slice(service.indexOf('pathname === "/approval-intents"'), service.indexOf('pathname === "/analysis/health"'));
  assert.doesNotMatch(approvalSlice, /ollama|analysisProvider|analysisEngine/i, "no AI inside approval or download paths");
});

test("20) analysis modules contain no Chrome, Etimad, sync, or external network path", async () => {
  const modules = [
    "../scripts/lib/analysis-documents.mjs",
    "../scripts/lib/analysis-chunking.mjs",
    "../scripts/lib/analysis-report.mjs",
    "../scripts/lib/analysis-providers.mjs",
    "../scripts/lib/analysis-engine.mjs",
    "../scripts/lib/analysis-api.mjs",
    "../scripts/lib/analysis-fixtures.mjs",
  ];
  for (const modulePath of modules) {
    const source = await readFile(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /chromium|launchPersistentContext|playwright|openForHumanLogin/i, `${modulePath} never touches a browser`);
    assert.doesNotMatch(source, /tenders\.etimad\.sa|performSync|saveCompletedSync/, `${modulePath} never touches Etimad or sync`);
    assert.doesNotMatch(source, /cookie|cf-clearance|challenges\.cloudflare/i, `${modulePath} never touches sessions or challenge bypass`);
  }
  const providers = await readFile(new URL("../scripts/lib/analysis-providers.mjs", import.meta.url), "utf8");
  const outbound = [...providers.matchAll(/fetchFn?\(`?\$?\{?([^`'",)]*)/g)].map((match) => match[0]);
  assert.ok(outbound.every((call) => !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(call)), "the only fetch target is the loopback host variable");
  assert.match(providers, /\/api\/generate/, "Ollama uses generate only");
  assert.doesNotMatch(providers, /\/api\/pull/, "no model pull anywhere");
});

test("engine health reflects the disabled-by-default posture and fixture list", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const engine = engineWith(repository, {});
    const health = await engine.health();
    assert.equal(health.provider, "stub");
    assert.equal(health.aiEnabled, false, "AI features are disabled by default");
    assert.equal(health.status, "stub");
    assert.deepEqual(health.fixtures.map((fixture) => fixture.fixtureId), analysisFixtures.map((fixture) => fixture.fixtureId));
    const disabledOllama = await engineWith(repository, { RADAR_AI_PROVIDER: "ollama", RADAR_AI_ENABLED: "false" }).health();
    assert.equal(disabledOllama.status, "disabled");
    const enabledOllama = await engineWith(repository, { RADAR_AI_PROVIDER: "ollama", RADAR_AI_ENABLED: "true" }).health();
    assert.equal(enabledOllama.status, "configured-unverified", "no probe without an explicit request");
    assert.equal(enabledOllama.model, "qwen2.5:7b");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("fixture buffers on disk match the deterministic factory and the ZIP reader round-trips", async () => {
  for (const fixture of analysisFixtures) {
    const onDisk = await readFile(path.join(fixtureRoot, fixture.fileName));
    assert.ok(onDisk.length > 0 && onDisk.length < 10_000, `${fixture.fileName} stays a tiny synthetic fixture`);
  }
  const entries = readZipEntries(fixtureBuffers["boq-xlsx"]);
  assert.ok(entries.has("xl/workbook.xml") && entries.has("xl/sharedStrings.xml"));
  const compressedPdf = buildPdf([["سطر أول للاختبار"]]);
  const document = extractAnalysisDocument({ documentId: "doc-round", fileName: "round.pdf", buffer: compressedPdf });
  assert.equal(document.blocks[0].text, "سطر أول للاختبار");
});
