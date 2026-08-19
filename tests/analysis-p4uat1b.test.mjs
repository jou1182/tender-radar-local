// اختبارات P4-UAT1B: إنشاء مهمة تحليل من مرجع مستند موثوق موجود فعلًا في
// المخزن الموثوق المحلي (.radar-data/attachments) بدل قائمة fixtures فقط.
// محاكاة محلية بالكامل: بلا شبكة، بلا Ollama/n8n/Chrome حي، بلا تنزيل،
// وبلا أي اتصال خارجي — المزود المستخدم هو stub الحتمي فقط.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { createAnalysisEngine } from "../scripts/lib/analysis-engine.mjs";
import { attachmentStorageRoot } from "../scripts/lib/attachment-storage.mjs";
import { buildPdf } from "./helpers/analysis-fixture-factory.mjs";

const fixtureRoot = fileURLToPath(new URL("../analysis-fixtures", import.meta.url));

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempRepository() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat1b-"));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

async function cleanup(projectRoot, repository) {
  repository?.close();
  await rm(projectRoot, { recursive: true, force: true });
}

// ينشئ مخزنًا موثوقًا مؤقتًا بداخله ملف PDF موثوق واحد، ويعيد المرجع الجاهز.
async function seedTrustedStore(projectRoot, { storedName = `${"a".repeat(64)}.pdf` } = {}) {
  const buffer = buildPdf([["الضمان الابتدائي: 5000 ريال سعودي", "نطاق العمل: أعمال حفر وتأسيس"]]);
  const storeRoot = attachmentStorageRoot(projectRoot);
  const tenderReference = "260000009999";
  await mkdir(path.join(storeRoot, tenderReference), { recursive: true });
  await writeFile(path.join(storeRoot, tenderReference, storedName), buffer);
  return { buffer, sha256: sha256(buffer), storeRoot, tenderReference, storedName };
}

function engineWith(repository, trustedStoreRoot, env = {}) {
  return createAnalysisEngine({
    repository,
    fixtureRoot,
    trustedStoreRoot,
    env: { RADAR_AI_ENABLED: "false", RADAR_AI_PROVIDER: "stub", ...env },
  });
}

test("P4-UAT1B-1) creates a queued job from an already-trusted stored document with a matching sha256 and runs through the same pipeline", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, seeded.storeRoot);

    const job = await engine.createJobFromStoredDocument({
      localStoredName: seeded.storedName,
      sha256: seeded.sha256,
      originalFileName: "local-brochure.pdf",
      documentType: "pdf",
    });

    assert.equal(job.jobStatus, "queued");
    assert.equal(job.provider, "stub");
    assert.equal(job.document.localStoredName, seeded.storedName, "the exact stored name is recorded");
    assert.equal(job.document.originalFileName, "local-brochure.pdf", "the caller metadata is recorded as metadata only");
    assert.equal(job.document.tenderReference, seeded.tenderReference, "the tender reference comes from the trusted store path");
    assert.equal(job.document.checksum, seeded.sha256, "the registered checksum equals the verified actual sha256");
    assert.equal(job.document.documentType, "pdf");
    assert.equal(job.document.fixtureId, "", "a stored document is never tied to a fixture");

    // يمر عبر نفس خط الأنابيب المعتمد: تشغيل حتمي بـ stub ينجح بتقرير مؤسس.
    const run = await engine.runJob(job.id);
    assert.equal(run.jobStatus, "completed");
    assert.ok(run.report.evidence.length > 0, "evidence was grounded from the trusted document");
    assert.equal(run.modelRuns.length, 1);
    assert.equal(run.modelRuns[0].status, "succeeded");
    assert.ok(run.report.bidBonds.some((finding) => finding.statement.includes("5000")), "the trusted document content was analyzed");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-2) a mismatched sha256 fails loudly and never creates a job", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, seeded.storeRoot);

    const wrongSha = "f".repeat(64);
    await assert.rejects(
      () => engine.createJobFromStoredDocument({
        localStoredName: seeded.storedName,
        sha256: wrongSha,
        originalFileName: "local-brochure.pdf",
        documentType: "pdf",
      }),
      (error) => error.code === "DOCUMENT_SHA256_MISMATCH",
    );

    const inspector = new DatabaseSync(repository.databasePath);
    try {
      assert.equal(Number(inspector.prepare("SELECT COUNT(*) AS count FROM analysis_documents").get().count), 0, "no document was registered");
      assert.equal(Number(inspector.prepare("SELECT COUNT(*) AS count FROM analysis_jobs").get().count), 0, "no job was created");
    } finally {
      inspector.close();
    }
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-3) a reference outside the trusted store is rejected", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, seeded.storeRoot);

    // ملف يقع خارج المخزن الموثوق إطلاقًا — حتى لو طُلب اسمه العادي:
    const outsideDir = path.join(projectRoot, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.pdf"), seeded.buffer);
    await assert.rejects(
      () => engine.createJobFromStoredDocument({
        localStoredName: "secret.pdf",
        sha256: seeded.sha256,
        originalFileName: "secret.pdf",
        documentType: "pdf",
      }),
      (error) => error.code === "ANALYSIS_DOCUMENT_NOT_IN_TRUSTED_STORE",
      "a plain name whose file lives outside the store is not trusted",
    );

    // مسار مطلق خارج المخزن مرفوض قبل أي بحث:
    await assert.rejects(
      () => engine.createJobFromStoredDocument({
        localStoredName: path.join(outsideDir, "secret.pdf"),
        sha256: seeded.sha256,
        originalFileName: "secret.pdf",
        documentType: "pdf",
      }),
      (error) => error.code === "DOCUMENT_PATH_NOT_ALLOWED",
      "an absolute path outside the store is rejected as a path, not a stored name",
    );
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-4) traversal and absolute-path attempts are rejected before any lookup", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, seeded.storeRoot);

    for (const malicious of ["../secret.pdf", "..\\secret.pdf", "sub/../secret.pdf", ".\\secret.pdf", "C:\\temp\\x.pdf", "C:/temp/x.pdf", "/etc/passwd"]) {
      await assert.rejects(
        () => engine.createJobFromStoredDocument({
          localStoredName: malicious,
          sha256: seeded.sha256,
          originalFileName: "secret.pdf",
          documentType: "pdf",
        }),
        (error) => error.code === "DOCUMENT_PATH_NOT_ALLOWED",
        malicious,
      );
    }
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-5) an inconsistent reference is rejected: bad sha format, unsupported type, declared type mismatch", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, seeded.storeRoot);
    const base = {
      localStoredName: seeded.storedName,
      sha256: seeded.sha256,
      originalFileName: "local-brochure.pdf",
      documentType: "pdf",
    };

    await assert.rejects(
      () => engine.createJobFromStoredDocument({ ...base, sha256: "not-a-hash" }),
      (error) => error.code === "ANALYSIS_DOCUMENT_REFERENCE_INVALID",
    );
    await assert.rejects(
      () => engine.createJobFromStoredDocument({ ...base, documentType: "exe" }),
      (error) => error.code === "DOCUMENT_TYPE_NOT_SUPPORTED",
    );
    await assert.rejects(
      () => engine.createJobFromStoredDocument({ ...base, documentType: "docx" }),
      (error) => error.code === "DOCUMENT_TYPE_MISMATCH",
    );
    await assert.rejects(
      () => engine.createJobFromStoredDocument({ ...base, localStoredName: "" }),
      (error) => error.code === "ANALYSIS_DOCUMENT_REFERENCE_INVALID",
    );
    await assert.rejects(
      () => engine.createJobFromStoredDocument({ ...base, originalFileName: "" }),
      (error) => error.code === "ANALYSIS_DOCUMENT_REFERENCE_INVALID",
    );
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-6) the engine without a configured trusted store refuses the new input path and never touches the fixture catalog", async () => {
  const { projectRoot, repository } = await tempRepository();
  try {
    const seeded = await seedTrustedStore(projectRoot);
    const engine = engineWith(repository, undefined);
    await assert.rejects(
      () => engine.createJobFromStoredDocument({
        localStoredName: seeded.storedName,
        sha256: seeded.sha256,
        originalFileName: "local-brochure.pdf",
        documentType: "pdf",
      }),
      (error) => error.code === "ANALYSIS_CONFIG",
    );
    // قائمة fixtures مغلقة وغير متأثرة:
    assert.equal(engine.listFixtures().length, 3, "the fixture catalog is untouched");
  } finally {
    await cleanup(projectRoot, repository);
  }
});

test("P4-UAT1B-7) the new engine code contains no live network, download, or browser path", async () => {
  const source = await readFile(new URL("../scripts/lib/analysis-engine.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chromium|launchPersistentContext|playwright|openForHumanLogin/i, "the engine never touches a browser");
  assert.doesNotMatch(source, /tenders\.etimad\.sa|performSync|saveCompletedSync/, "the engine never touches Etimad or sync");
  assert.doesNotMatch(source, /\.download\(|live-acquisition|api\/pull/, "the engine never downloads or pulls");
});