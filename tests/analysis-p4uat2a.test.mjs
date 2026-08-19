// اختبارات P4-UAT2A: أداتا وضع مستند موثوق يدويًا وتشغيل تحليل عليه.
// كود فقط — محاكاة محلية بالكامل بملفات PDF اصطناعية مؤقتة، بلا شبكة، بلا
// Ollama/n8n/Chrome حي، وبلا أي مستند حقيقي. المزود المستخدم هو stub الحتمي فقط.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPdf } from "./helpers/analysis-fixture-factory.mjs";
import { attachmentStorageRoot } from "../scripts/lib/attachment-storage.mjs";
import { placeTrustedDocument, runTrustedDocumentAnalysis } from "../scripts/lib/trusted-document-cli.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-"));
}

async function cleanup(projectRoot) {
  await rm(projectRoot, { recursive: true, force: true });
}

test("P4-UAT2A-1) placeTrustedDocument places a real temporary source file into the trusted store and returns a ready reference", async () => {
  const projectRoot = await tempProject();
  try {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-src-"));
    const sourceFilePath = path.join(sourceDir, "real-brochure.pdf");
    const buffer = buildPdf([["الضمان الابتدائي: 5000 ريال سعودي", "نطاق العمل: أعمال حفر وتأسيس"]]);
    await writeFile(sourceFilePath, buffer);
    const tenderReference = "260000009999";

    const placed = await placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName: "brochure.pdf" });

    assert.ok(placed.storedPath.startsWith(attachmentStorageRoot(projectRoot)), "the file lives under the trusted store");
    assert.equal(placed.tenderReference, tenderReference);
    assert.equal(placed.sha256, sha256(buffer), "sha256 computed from the actually-copied content");
    assert.equal(placed.sizeBytes, buffer.length);
    assert.equal(placed.localStoredName, path.basename(placed.storedPath));

    const onDisk = await readFile(placed.storedPath);
    assert.equal(sha256(onDisk), sha256(buffer), "the copied bytes match the source exactly");
  } finally {
    await cleanup(projectRoot);
  }
});

test("P4-UAT2A-2) placeTrustedDocument refuses to overwrite an existing destination file", async () => {
  const projectRoot = await tempProject();
  try {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-src2-"));
    const sourceFilePath = path.join(sourceDir, "brochure.pdf");
    const buffer = buildPdf([["نص تجريبي"]]);
    await writeFile(sourceFilePath, buffer);
    const tenderReference = "260000009999";

    const first = await placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName: "brochure.pdf" });
    await assert.rejects(
      () => placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName: "brochure.pdf" }),
      (error) => error.code === "DOCUMENT_ALREADY_EXISTS",
      "a second placement for the same stored path must be rejected without silent overwrite",
    );
    assert.ok(first.storedPath, "the first placement succeeded");
  } finally {
    await cleanup(projectRoot);
  }
});

test("P4-UAT2A-3) placeTrustedDocument rejects an invalid tender reference", async () => {
  const projectRoot = await tempProject();
  try {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-src3-"));
    const sourceFilePath = path.join(sourceDir, "brochure.pdf");
    await writeFile(sourceFilePath, buildPdf([["نص تجريبي"]]));

    for (const invalid of ["../ref", "2600 000", "", "a/b", "ref;DROP"]) {
      await assert.rejects(
        () => placeTrustedDocument({ projectRoot, tenderReference: invalid, sourceFilePath, displayName: "brochure.pdf" }),
        (error) => error.code === "INVALID_TENDER_REFERENCE",
        JSON.stringify(invalid),
      );
    }
  } finally {
    await cleanup(projectRoot);
  }
});

test("P4-UAT2A-4) placeTrustedDocument rejects traversal and absolute display names", async () => {
  const projectRoot = await tempProject();
  try {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-src4-"));
    const sourceFilePath = path.join(sourceDir, "brochure.pdf");
    await writeFile(sourceFilePath, buildPdf([["نص تجريبي"]]));
    const tenderReference = "260000009999";

    for (const malicious of ["../secret.pdf", "..\\secret.pdf", "sub/../secret.pdf", ".\\secret.pdf", "C:\\temp\\x.pdf", "C:/temp/x.pdf", "/etc/passwd"]) {
      await assert.rejects(
        () => placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName: malicious }),
        (error) => error.code === "INVALID_STORAGE_PATH",
        malicious,
      );
    }
  } finally {
    await cleanup(projectRoot);
  }
});

test("P4-UAT2A-5) runTrustedDocumentAnalysis runs a stored document end-to-end with the stub provider and completes with a grounded report", async () => {
  const projectRoot = await tempProject();
  try {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "radar-p4uat2a-src5-"));
    const sourceFilePath = path.join(sourceDir, "local-brochure.pdf");
    const buffer = buildPdf([["الضمان الابتدائي: 5000 ريال سعودي", "نطاق العمل: أعمال حفر وتأسيس"]]);
    await writeFile(sourceFilePath, buffer);
    const tenderReference = "260000009999";

    const placed = await placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName: "brochure.pdf" });

    const job = await runTrustedDocumentAnalysis({
      projectRoot,
      localStoredName: placed.localStoredName,
      sha256: placed.sha256,
      originalFileName: "local-brochure.pdf",
      documentType: "pdf",
      env: { RADAR_AI_ENABLED: "false", RADAR_AI_PROVIDER: "stub" },
    });

    assert.equal(job.jobStatus, "completed");
    assert.equal(job.provider, "stub");
    assert.ok(job.report.evidence.length > 0, "evidence was grounded from the trusted document");
    assert.equal(job.modelRuns.length, 1);
    assert.equal(job.modelRuns[0].status, "succeeded");
    assert.ok(job.report.bidBonds.some((finding) => finding.statement.includes("5000")), "the trusted document content was analyzed");
  } finally {
    await cleanup(projectRoot);
  }
});

test("P4-UAT2A-6) the module contains no live network, browser, download, or OS-command path", async () => {
  const source = await readFile(new URL("../scripts/lib/trusted-document-cli.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chromium|launchPersistentContext|playwright|openForHumanLogin/i, "the module never touches a browser");
  assert.doesNotMatch(source, /tenders\.etimad\.sa|performSync|saveCompletedSync/i, "the module never touches Etimad or sync");
  assert.doesNotMatch(source, /child_process|\.download\(|execSync|exec\(|spawn\(|api\/pull/i, "the module never runs OS commands, downloads, or pulls");
});
