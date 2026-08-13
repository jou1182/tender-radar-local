// اختبارات P3-B1A: المحوّل الحي المحكوم — fixtures ومحاكاة فقط، بلا شبكة ولا Chrome ولا تنزيل حقيقي.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { downloadConsentPhrase, hashDownloadManifest } from "../scripts/lib/download-gate.mjs";
import { resolveAttachmentStoragePath } from "../scripts/lib/attachment-storage.mjs";
import {
  assertLivePreconditions,
  assertTrustedTenderUrl,
  assertManifestMatchesLiveAllowlist,
  assertSafeDownloadTrigger,
  createLiveDownloadAdapter,
  engageLiveKillSwitch,
  inspectQuarantinedFile,
  liveKillSwitchPath,
  quarantinePathFor,
  readLiveAcquisitionConfig,
} from "../scripts/lib/live-attachment-acquisition.mjs";

const tender = {
  id: "260000000700",
  reference: "260000000700",
  title: "منافسة المحوّل الحي المحكوم",
  agency: "جهة اختبار",
  fee: 0,
  region: "منطقة الرياض",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=p3b1",
  score: 70,
  remoteAttachments: [],
};

const freeFile = "كراسة الشروط.pdf";
const pdfFixture = Buffer.from("%PDF-1.7\n%P3-B1A fixture\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function repositoryWithTender({ fee = 0, attachmentStates = { [freeFile]: "free-available" } } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p3b1-"));
  const repository = await createRadarRepository({ projectRoot });
  const names = Object.keys(attachmentStates);
  const live = { ...tender, fee, remoteAttachments: names };
  const runId = repository.startSyncRun();
  repository.saveCompletedSync({
    lastSyncAt: "2026-08-14T00:00:00.000Z", checked: 1, regions: 13, targetPerRegion: 100,
    added: [live], changed: [], items: [live],
  }, runId);
  for (const [name, availability] of Object.entries(attachmentStates)) {
    repository.setAttachmentAvailability(tender.reference, name, availability);
  }
  return { projectRoot, repository };
}

function approve(repository, { files = [{ displayName: freeFile }], purchaseConfirmed = false } = {}) {
  const intent = repository.requestDownloadApprovalIntent({ tenderReference: tender.reference, files });
  return repository.confirmDownloadApprovalIntent(intent.id, {
    consentText: downloadConsentPhrase,
    purchaseConfirmed,
  });
}

function liveEnv(approval, overrides = {}) {
  return {
    RADAR_LIVE_DOWNLOAD_ENABLED: "true",
    RADAR_LIVE_DOWNLOAD_TENDER_REF: tender.reference,
    RADAR_LIVE_DOWNLOAD_FILE_NAME: freeFile,
    RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256: hashDownloadManifest(approval.scope),
    ...overrides,
  };
}

function createAdapter({ repository, projectRoot, env, driver, maxBytes, timeoutMs, preflightTimeoutMs }) {
  return createLiveDownloadAdapter({
    repository,
    projectRoot,
    privateDir: path.join(projectRoot, ".radar-data"),
    env,
    driver,
    maxBytes,
    timeoutMs,
    preflightTimeoutMs,
  });
}

function pdfSimulator(fixture = pdfFixture, info = { contentType: "application/pdf" }) {
  const calls = [];
  const driver = {
    async preflight({ tender, displayName }) {
      return { ready: true, tenderReference: tender.reference, displayName, targetId: "fixture-download", elementInfo: { text: displayName } };
    },
    async acquire({ quarantinePath, signal }) {
      calls.push(quarantinePath);
      if (signal?.aborted) throw new Error("aborted");
      await writeFile(quarantinePath, fixture);
      return info;
    },
  };
  return { driver, calls };
}

async function quarantineEntries(projectRoot) {
  try {
    return await readdir(path.join(projectRoot, ".radar-data", "quarantine"));
  } catch {
    return [];
  }
}

async function expectRejectedAndUnconsumed({ adapter, approval, jobId, code }) {
  await assert.rejects(
    () => adapter.execute({ id: jobId, approvalId: approval.id, manifest: approval.scope }),
    (error) => error.code === code,
  );
  return null;
}

test("the live adapter is disabled by default and never consumes the approval", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const adapter = createAdapter({ repository, projectRoot, env: {}, driver: pdfSimulator().driver });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-disabled-default", code: "LIVE_ADAPTER_DISABLED" });
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved", "disabled adapter keeps the approval usable");
    assert.deepEqual(await quarantineEntries(projectRoot), [], "no quarantine artifact when disabled");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the kill switch (env) disables the adapter immediately even with a complete allowlist", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const env = liveEnv(approval, { RADAR_LIVE_DOWNLOAD_KILL: "true" });
    const simulator = pdfSimulator();
    const adapter = createAdapter({ repository, projectRoot, env, driver: simulator.driver });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-kill-env", code: "LIVE_ADAPTER_DISABLED" });
    assert.equal(simulator.calls.length, 0, "kill switch stops execution before any transfer");
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the kill switch file engages and disengages immediately without a restart", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const privateDir = path.join(projectRoot, ".radar-data");
    const simulator = pdfSimulator();
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver: simulator.driver });

    await engageLiveKillSwitch(privateDir);
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-kill-file", code: "LIVE_ADAPTER_DISABLED" });
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved", "killed adapter never consumes");

    await rm(liveKillSwitchPath(privateDir), { force: true });
    const job = repository.recordDownloadJob({ approvalId: approval.id, tenderReference: approval.tenderReference, manifest: approval.scope, status: "running" });
    const result = await adapter.execute({ id: job.id, approvalId: approval.id, manifest: approval.scope });
    assert.equal(result.status, "complete", "removing the kill file re-enables without recreating the adapter");
    assert.equal(simulator.calls.length, 1);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("an incomplete allowlist keeps the adapter disabled and the approval unconsumed", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    for (const missing of ["RADAR_LIVE_DOWNLOAD_TENDER_REF", "RADAR_LIVE_DOWNLOAD_FILE_NAME", "RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256"]) {
      const env = liveEnv(approval, { [missing]: "" });
      const adapter = createAdapter({ repository, projectRoot, env, driver: pdfSimulator().driver });
      await expectRejectedAndUnconsumed({ adapter, approval, jobId: `job-incomplete-${missing}`, code: "LIVE_ADAPTER_DISABLED" });
    }
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("any manifest outside the single-tender single-file allowlist is rejected before consumption", async () => {
  const { projectRoot, repository } = await repositoryWithTender({
    attachmentStates: { [freeFile]: "free-available", "المخططات.zip": "free-available" },
  });
  try {
    const approval = approve(repository);
    const cases = [
      { RADAR_LIVE_DOWNLOAD_TENDER_REF: "999999999999" },
      { RADAR_LIVE_DOWNLOAD_FILE_NAME: "ملف-آخر.pdf" },
      { RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256: "0".repeat(64) },
    ];
    for (const overrides of cases) {
      const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval, overrides), driver: pdfSimulator().driver });
      await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-allowlist", code: "LIVE_ALLOWLIST_MISMATCH" });
    }
    const twoFileApproval = approve(repository, { files: [{ displayName: freeFile }, { displayName: "المخططات.zip" }] });
    const twoFileAdapter = createAdapter({
      repository, projectRoot,
      env: liveEnv(twoFileApproval),
      driver: pdfSimulator().driver,
    });
    await expectRejectedAndUnconsumed({ adapter: twoFileAdapter, approval: twoFileApproval, jobId: "job-two-files", code: "LIVE_ALLOWLIST_MISMATCH" });
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
    assert.equal(repository.getDownloadApproval(twoFileApproval.id).status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pre-click checks require a zero booklet fee and free-available state", async () => {
  const paid = await repositoryWithTender({ fee: 10, attachmentStates: { [freeFile]: "purchased-available" } });
  try {
    const approval = approve(paid.repository, { purchaseConfirmed: true });
    const adapter = createAdapter({
      repository: paid.repository, projectRoot: paid.projectRoot,
      env: liveEnv(approval), driver: pdfSimulator().driver,
    });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-paid", code: "LIVE_PRECHECK_FAILED" });
    assert.equal(paid.repository.getDownloadApproval(approval.id).status, "approved", "paid tenders are refused before consumption");
  } finally {
    paid.repository.close();
    await rm(paid.projectRoot, { recursive: true, force: true });
  }
  assert.throws(
    () => assertLivePreconditions({ tender: { fee: 0, attachmentsMeta: [{ displayName: "x.pdf", availability: "metadata-only" }] }, displayName: "x.pdf" }),
    (error) => error.code === "LIVE_PRECHECK_FAILED",
  );
  assert.throws(
    () => assertLivePreconditions({ tender: null, displayName: "x.pdf" }),
    (error) => error.code === "LIVE_PRECHECK_FAILED",
  );
  assert.throws(
    () => assertLivePreconditions({ tender: { fee: 0, attachmentsMeta: [{ displayName: "x.pdf", availability: "free-available", remoteVisible: false }] }, displayName: "x.pdf" }),
    (error) => error.code === "LIVE_PRECHECK_FAILED",
  );
});

test("only an HTTPS Etimad Tender URL is trusted", () => {
  assert.match(assertTrustedTenderUrl(tender.etimadUrl), /^https:\/\/tenders\.etimad\.sa\/Tender\//);
  for (const value of [
    "http://tenders.etimad.sa/Tender/Details?id=1",
    "https://evil.example/Tender/Details?id=1",
    "https://tenders.etimad.sa.evil.example/Tender/Details?id=1",
    "https://tenders.etimad.sa/Account/Login",
  ]) {
    assert.throws(() => assertTrustedTenderUrl(value), (error) => error.code === "LIVE_UNTRUSTED_URL");
  }
});

test("a mismatched driver target is rejected before approval consumption", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const driver = {
      async preflight() { return { ready: true, tenderReference: "wrong", displayName: freeFile, targetId: "wrong", elementInfo: { text: freeFile } }; },
      async acquire() { throw new Error("must not acquire"); },
    };
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-target-mismatch", code: "LIVE_TARGET_MISMATCH" });
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a stalled preflight times out without consuming approval or acquiring", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    let acquired = false;
    const driver = {
      async preflight() { await new Promise(() => {}); },
      async acquire() { acquired = true; },
    };
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver, preflightTimeoutMs: 15 });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-preflight-timeout", code: "LIVE_PREFLIGHT_TIMEOUT" });
    assert.equal(acquired, false);
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("successful guarded execution consumes once, inspects, and moves atomically out of quarantine", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const simulator = pdfSimulator();
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver: simulator.driver });
    const job = repository.recordDownloadJob({ approvalId: approval.id, tenderReference: approval.tenderReference, manifest: approval.scope, status: "running" });
    const result = await adapter.execute({ id: job.id, approvalId: approval.id, manifest: approval.scope });

    assert.equal(result.status, "complete");
    assert.equal(result.files.length, 1);
    const expectedSha = createHash("sha256").update(pdfFixture).digest("hex");
    assert.equal(result.sha256, expectedSha);
    assert.equal(result.size, pdfFixture.length);

    const finalPath = resolveAttachmentStoragePath(projectRoot, tender.reference, freeFile);
    assert.equal(result.files[0], finalPath);
    const stored = await stat(finalPath);
    assert.equal(stored.size, pdfFixture.length);
    assert.equal(path.basename(finalPath) === freeFile, false, "stored under a generated internal name, not the display name");
    assert.deepEqual(await quarantineEntries(projectRoot), [], "quarantine is empty after the atomic move");
    const storedMeta = repository.listAttachmentMeta(tender.reference).find((item) => item.displayName === freeFile);
    assert.equal(storedMeta.downloadStatus, "downloaded");
    assert.equal(storedMeta.localPath, finalPath);
    assert.equal(storedMeta.sha256, expectedSha);

    const consumed = repository.getDownloadApproval(approval.id);
    assert.equal(consumed.status, "consumed", "approval is consumed exactly when live execution starts");
    assert.equal(simulator.calls.length, 1, "no automatic retry");
    repository.updateDownloadJob(job.id, { status: "complete", finished: true });
    assert.equal(repository.listDownloadJobs(tender.reference)[0].status, "complete");

    const secondApproval = approve(repository);
    const secondAdapter = createAdapter({ repository, projectRoot, env: liveEnv(secondApproval), driver: simulator.driver });
    await assert.rejects(
      () => secondAdapter.execute({ id: "job-replay", approvalId: approval.id, manifest: approval.scope }),
      (error) => error.code === "APPROVAL_CONSUMED",
      "a burned approval cannot replay the download",
    );
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a transfer beyond 100MB is canceled and rolled back, with no retry", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const oversized = Buffer.concat([pdfFixture, Buffer.alloc(2_048, 0x41)]);
    const simulator = pdfSimulator(oversized);
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver: simulator.driver, maxBytes: 1_024 });
    const job = repository.recordDownloadJob({ approvalId: approval.id, tenderReference: approval.tenderReference, manifest: approval.scope, status: "running" });
    await assert.rejects(
      () => adapter.execute({ id: job.id, approvalId: approval.id, manifest: approval.scope }),
      (error) => error.code === "LIVE_FILE_TOO_LARGE",
    );
    assert.equal(simulator.calls.length, 1, "no automatic retry after a size failure");
    assert.deepEqual(await quarantineEntries(projectRoot), [], "rollback removes the oversized quarantine file");
    const finalPath = resolveAttachmentStoragePath(projectRoot, tender.reference, freeFile);
    await assert.rejects(() => stat(finalPath), "nothing reaches the attachments folder");
    assert.equal(repository.getDownloadApproval(approval.id).status, "consumed", "execution had already started");
    repository.updateDownloadJob(job.id, { status: "failed", errorMessage: "LIVE_FILE_TOO_LARGE", finished: true });
    assert.equal(repository.listDownloadJobs(tender.reference)[0].status, "failed");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a timed-out transfer is aborted, cleaned, and never retried", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    let calls = 0;
    let aborted = false;
    const driver = {
      async preflight() { return { ready: true, tenderReference: tender.reference, displayName: freeFile, targetId: "slow", elementInfo: { text: freeFile } }; },
      async acquire({ quarantinePath, signal }) {
        calls += 1;
        await writeFile(quarantinePath, pdfFixture.subarray(0, 8));
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        aborted = true;
        throw new Error("aborted by guard");
      },
    };
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver, timeoutMs: 25 });
    await assert.rejects(
      () => adapter.execute({ id: "job-timeout", approvalId: approval.id, manifest: approval.scope }),
      (error) => error.code === "LIVE_DOWNLOAD_TIMEOUT",
    );
    assert.equal(calls, 1);
    assert.equal(aborted, true);
    assert.deepEqual(await quarantineEntries(projectRoot), []);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P3-B1A has no production driver and fails before consuming an enabled approval", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver: null });
    await expectRejectedAndUnconsumed({ adapter, approval, jobId: "job-no-driver", code: "LIVE_DRIVER_NOT_CONFIGURED" });
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
    assert.deepEqual(await quarantineEntries(projectRoot), []);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the feature flag accepts only the exact lowercase value true", () => {
  for (const value of ["TRUE", "True", "1", "yes", " true ", "false"]) {
    assert.equal(readLiveAcquisitionConfig({ RADAR_LIVE_DOWNLOAD_ENABLED: value }).enabled, false);
  }
  assert.equal(readLiveAcquisitionConfig({ RADAR_LIVE_DOWNLOAD_ENABLED: "true" }).enabled, true);
});

test("signature, MIME, and extension mismatches are rejected and rolled back", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const badSignature = Buffer.from("plain text pretending to be a booklet");
    const approvalOne = approve(repository);
    const adapterOne = createAdapter({
      repository, projectRoot, env: liveEnv(approvalOne),
      driver: pdfSimulator(badSignature).driver,
    });
    await assert.rejects(
      () => adapterOne.execute({ id: "job-sig", approvalId: approvalOne.id, manifest: approvalOne.scope }),
      (error) => error.code === "LIVE_SIGNATURE_MISMATCH",
    );

    const approvalTwo = approve(repository);
    const adapterTwo = createAdapter({
      repository, projectRoot, env: liveEnv(approvalTwo),
      driver: pdfSimulator(pdfFixture, { contentType: "text/html" }).driver,
    });
    await assert.rejects(
      () => adapterTwo.execute({ id: "job-mime", approvalId: approvalTwo.id, manifest: approvalTwo.scope }),
      (error) => error.code === "LIVE_MIME_MISMATCH",
    );
    assert.deepEqual(await quarantineEntries(projectRoot), [], "both rejections roll back cleanly");
    await assert.rejects(
      () => stat(resolveAttachmentStoragePath(projectRoot, tender.reference, freeFile)),
      "rejected files never reach the attachments folder",
    );

    const quarantineProbe = quarantinePathFor(path.join(projectRoot, ".radar-data"), "probe", "برنامج.exe");
    await mkdir(path.dirname(quarantineProbe), { recursive: true });
    await writeFile(quarantineProbe, pdfFixture);
    await assert.rejects(
      () => inspectQuarantinedFile({ quarantinePath: quarantineProbe, displayName: "برنامج.exe" }),
      (error) => error.code === "EXTENSION_NOT_ALLOWED",
    );
    const emptyProbe = quarantinePathFor(path.join(projectRoot, ".radar-data"), "probe-empty", freeFile);
    await mkdir(path.dirname(emptyProbe), { recursive: true });
    await writeFile(emptyProbe, Buffer.alloc(0));
    await assert.rejects(
      () => inspectQuarantinedFile({ quarantinePath: emptyProbe, displayName: freeFile }),
      (error) => error.code === "LIVE_INSPECTION_FAILED",
    );
    const zipProbe = quarantinePathFor(path.join(projectRoot, ".radar-data"), "probe-zip", "المخططات.zip");
    const zipFixture = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]);
    await mkdir(path.dirname(zipProbe), { recursive: true });
    await writeFile(zipProbe, zipFixture);
    const zipInspection = await inspectQuarantinedFile({ quarantinePath: zipProbe, displayName: "المخططات.zip", contentType: "application/octet-stream" });
    assert.equal(zipInspection.extension, "zip");
    assert.equal(zipInspection.sha256, createHash("sha256").update(zipFixture).digest("hex"));
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("purchase, payment, join, or offer elements are refused before any click", async () => {
  const unsafe = [
    { text: "شراء الكراسة" },
    { text: "دفع الرسوم" },
    { text: "انضمام إلى المنافسة" },
    { text: "تقديم العرض الآن" },
    { href: "https://tenders.etimad.sa/Tender/Purchase?id=1" },
    { href: "https://tenders.etimad.sa/payment/checkout" },
    { ariaLabel: "join tender now" },
  ];
  for (const info of unsafe) {
    assert.throws(() => assertSafeDownloadTrigger(info), (error) => error.code === "LIVE_UNSAFE_ELEMENT");
  }
  assert.equal(assertSafeDownloadTrigger({ text: freeFile, href: "https://tenders.etimad.sa/Tender/Attachment?id=55" }), true);
});

test("an acquire failure rolls back quarantine, records a failed job, and never retries", async () => {
  const { projectRoot, repository } = await repositoryWithTender();
  try {
    const approval = approve(repository);
    let calls = 0;
    const failingDriver = {
      async preflight() { return { ready: true, tenderReference: tender.reference, displayName: freeFile, targetId: "failure", elementInfo: { text: freeFile } }; },
      async acquire({ quarantinePath }) {
        calls += 1;
        await writeFile(quarantinePath, Buffer.from("partial-transfer"));
        const error = new Error("browser transfer aborted");
        error.code = "LIVE_DOWNLOAD_FAILED";
        throw error;
      },
    };
    const adapter = createAdapter({ repository, projectRoot, env: liveEnv(approval), driver: failingDriver });
    const job = repository.recordDownloadJob({ approvalId: approval.id, tenderReference: approval.tenderReference, manifest: approval.scope, status: "running" });
    await assert.rejects(
      () => adapter.execute({ id: job.id, approvalId: approval.id, manifest: approval.scope }),
      (error) => error.code === "LIVE_DOWNLOAD_FAILED",
    );
    assert.equal(calls, 1, "no automatic retry after a transfer failure");
    assert.deepEqual(await quarantineEntries(projectRoot), [], "partial quarantine file removed on rollback");
    const failed = repository.updateDownloadJob(job.id, { status: "failed", errorMessage: "LIVE_DOWNLOAD_FAILED", finished: true });
    assert.equal(failed.status, "failed");
    assert.equal(repository.getDownloadApproval(approval.id).status, "consumed", "the failure happened after execution started");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("allowlist unit checks: single file, exact reference, exact name, exact fingerprint", async () => {
  const manifest = { tenderReference: tender.reference, files: [{ displayName: freeFile, size: null }] };
  const config = readLiveAcquisitionConfig({
    RADAR_LIVE_DOWNLOAD_ENABLED: "true",
    RADAR_LIVE_DOWNLOAD_TENDER_REF: tender.reference,
    RADAR_LIVE_DOWNLOAD_FILE_NAME: freeFile,
    RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256: hashDownloadManifest(manifest),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.allowlistComplete, true);
  assert.equal(assertManifestMatchesLiveAllowlist({ manifest, config }), true);
  assert.throws(
    () => assertManifestMatchesLiveAllowlist({ manifest: { tenderReference: tender.reference, files: [] }, config }),
    (error) => error.code === "LIVE_ALLOWLIST_MISMATCH",
  );
});

test("live module and service wiring keep the safety invariants textually", async () => {
  const [liveModule, service] = await Promise.all([
    readFile(new URL("../scripts/lib/live-attachment-acquisition.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(liveModule, /RADAR_LIVE_DOWNLOAD_ENABLED/);
  assert.match(liveModule, /RADAR_LIVE_DOWNLOAD_KILL/);
  assert.match(liveModule, /RADAR_LIVE_DOWNLOAD_TENDER_REF/);
  assert.match(liveModule, /RADAR_LIVE_DOWNLOAD_FILE_NAME/);
  assert.match(liveModule, /RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256/);
  assert.match(liveModule, /consumeDownloadApproval/, "consumption happens inside the guarded module");
  assert.match(liveModule, /LIVE_DRIVER_NOT_CONFIGURED/);
  assert.match(liveModule, /quarantine/);
  assert.doesNotMatch(liveModule, /getEtimadPage|page\.goto|locator\(|\.click\(|launchPersistentContext|chromium\.launch|openForHumanLogin/, "P3-B1A contains no production browser driver or selectors");
  assert.doesNotMatch(liveModule, /fetch\(|cookies\(|challenges\.cloudflare|cf-clearance/i, "no direct fetch, cookies, or challenge bypass");
  assert.doesNotMatch(liveModule, /spawn\(|child_process|unzip|decompress/i, "no extraction or process execution on files");
  assert.doesNotMatch(liveModule, /\.download\(|page\.download/, "playwright transfer object is handled without the forbidden call shape");

  assert.match(service, /createLiveDownloadAdapter/);
  assert.match(service, /pathname === "\/approval-jobs\/live"/);
  assert.match(service, /HUMAN_CONFIRMATION_ORIGIN_REQUIRED/);
  assert.match(service, /p3b1-live-guarded-1/);
  assert.doesNotMatch(service, /consumeDownloadApproval/, "consumption stays inside the guarded module, never in the service");
  const jobRoute = service.slice(service.indexOf('pathname === "/approval-jobs"'), service.indexOf('pathname === "/approval-jobs"') + 2200);
  assert.doesNotMatch(jobRoute, /liveAcquisitionAdapter/, "the B0 route stays untouched; the live route is separate");
});
