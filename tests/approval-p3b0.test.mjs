import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import {
  approvalTtlMs,
  allowedDownloadExtensions,
  downloadConsentPhrase,
  hashDownloadManifest,
  purchaseConsentPhrase,
  validateDownloadRequest,
} from "../scripts/lib/download-gate.mjs";
import { attachmentTenderDir, resolveAttachmentStoragePath } from "../scripts/lib/attachment-storage.mjs";
import { createDisabledProductionDownloadAdapter, createFakeDownloadAdapter } from "../scripts/lib/attachment-adapters.mjs";

const tender = {
  id: "260000000500",
  reference: "260000000500",
  title: "منافسة بوابة الموافقة",
  agency: "جهة اختبار",
  fee: 0,
  region: "منطقة الرياض",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=p3b0",
  score: 70,
  remoteAttachments: [],
};

async function repositoryWithTender({ fee = 0, attachmentStates = {} } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p3b0-"));
  const repository = await createRadarRepository({ projectRoot });
  const names = Object.keys(attachmentStates);
  const live = { ...tender, fee, remoteAttachments: names };
  const runId = repository.startSyncRun();
  repository.saveCompletedSync({
    lastSyncAt: "2026-08-13T21:00:00.000Z", checked: 1, regions: 13, targetPerRegion: 100,
    added: [live], changed: [], items: [live],
  }, runId);
  if (fee === 0) {
    repository.saveTenderDetails({
      reference: tender.reference, status: "complete", inspectedAt: "2026-08-13T21:05:00.000Z",
      sourceUrl: tender.etimadUrl, pageTitle: "", sections: [],
      fields: { bookletFee: "0" },
      attachments: names.map((displayName) => ({ displayName })),
    });
  }
  for (const [name, availability] of Object.entries(attachmentStates)) {
    repository.setAttachmentAvailability(tender.reference, name, availability);
  }
  return { projectRoot, repository };
}

const approvalInput = {
  tenderReference: tender.reference,
  files: [{ displayName: "كراسة الشروط.pdf" }],
  consentText: downloadConsentPhrase,
  purchaseConfirmed: false,
};

function approve(repository, input = approvalInput) {
  const intent = repository.requestDownloadApprovalIntent({
    tenderReference: input.tenderReference,
    files: input.files,
    now: input.now,
  });
  return repository.confirmDownloadApprovalIntent(intent.id, {
    consentText: input.consentText,
    purchaseConfirmed: input.purchaseConfirmed,
    now: input.now,
  });
}

function consume(repository, approval, options = {}) {
  return repository.consumeDownloadApproval(approval.id, { manifest: approval.scope, ...options });
}

test("Schema v6 migration preserves v4 tenders, details, attachments, and legacy approvals", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-v4-"));
  let repository;
  try {
    const privateDir = path.join(projectRoot, ".radar-data");
    await mkdir(privateDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(privateDir, "radar.sqlite"));
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-08-13T20:00:00.000Z');
      CREATE TABLE tenders (
        reference TEXT PRIMARY KEY, title TEXT NOT NULL, agency TEXT NOT NULL,
        fee INTEGER NOT NULL DEFAULT 0, region TEXT NOT NULL, deadline TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '', platform_status TEXT NOT NULL DEFAULT '',
        activity TEXT NOT NULL DEFAULT '', sub_activity TEXT NOT NULL DEFAULT '',
        tender_type TEXT NOT NULL DEFAULT '', etimad_url TEXT NOT NULL DEFAULT '',
        tender_number TEXT NOT NULL DEFAULT '', contract_duration TEXT NOT NULL DEFAULT '',
        guarantee TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        quantity_summary TEXT NOT NULL DEFAULT '', attachment_names_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO tenders (reference, title, agency, fee, region, deadline, first_seen_at, last_seen_at)
        VALUES ('260000000500', 'منافسة من v4', 'جهة اختبار', 0, 'منطقة الرياض', '2026-09-01 09:59', '2026-08-13T20:00:00.000Z', '2026-08-13T20:00:00.000Z');
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tender_reference TEXT NOT NULL,
        display_name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'supporting',
        remote_visible INTEGER NOT NULL DEFAULT 1, download_status TEXT NOT NULL DEFAULT 'not-downloaded',
        availability TEXT NOT NULL DEFAULT 'unknown', requires_approval INTEGER NOT NULL DEFAULT 1,
        availability_updated_at TEXT, local_path TEXT, sha256 TEXT, mime_type TEXT, size INTEGER,
        UNIQUE (tender_reference, display_name)
      );
      INSERT INTO attachments (tender_reference, display_name, kind, availability)
        VALUES ('260000000500', 'كراسة الشروط.pdf', 'booklet', 'free-available');
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        tender_reference TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        consumed_at TEXT
      );
      INSERT INTO approvals (id, tender_reference, action, target, approved_at)
        VALUES ('legacy-approval-1', '260000000500', 'download-attachments', 'attachments', '2026-08-13T20:00:00.000Z');
    `);
    legacy.close();

    repository = await createRadarRepository({ projectRoot });
    assert.equal(repository.schemaVersion, 6);
    const stored = repository.getTender("260000000500");
    assert.equal(stored.title, "منافسة من v4");
    assert.equal(stored.feeVerification, "unknown");
    const meta = repository.listAttachmentMeta("260000000500");
    assert.equal(meta[0].availability, "free-available", "v4 availability data survives the v6 migration");
    const legacyApproval = repository.getDownloadApproval("legacy-approval-1");
    assert.equal(legacyApproval.tenderReference, "260000000500");
    assert.equal(legacyApproval.status, "revoked", "legacy approvals without scope and expiry are unusable");
    assert.throws(
      () => repository.consumeDownloadApproval(legacyApproval.id, { manifest: { tenderReference: tender.reference, files: [] } }),
      (error) => error.code === "APPROVAL_REVOKED",
    );
    assert.deepEqual(repository.listDownloadJobs(), []);

    assert.throws(
      () => repository.requestDownloadApprovalIntent({ tenderReference: tender.reference, files: approvalInput.files }),
      (error) => error.code === "FEE_NOT_DETAIL_VERIFIED",
    );
    repository.saveTenderDetails({
      reference: tender.reference, status: "complete", inspectedAt: "2026-08-13T21:05:00.000Z",
      sourceUrl: tender.etimadUrl, pageTitle: "", sections: [],
      fields: { bookletFee: "0" },
      attachments: [{ displayName: "كراسة الشروط.pdf", kind: "booklet" }],
    });

    const approval = approve(repository);
    assert.equal(approval.action, "download-attachments");
    assert.ok(approval.scopeHash);

    repository.close();
    repository = await createRadarRepository({ projectRoot });
    assert.equal(repository.getTender("260000000500").title, "منافسة من v4", "reopening keeps migrated data");
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved");
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("approval expires after exactly 10 minutes", async () => {
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: { "كراسة الشروط.pdf": "free-available" } });
  try {
    const created = new Date("2026-08-13T21:00:00.000Z");
    const approval = approve(repository, { ...approvalInput, now: created });
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt), approvalTtlMs);

    const stillValid = consume(repository, approval, { now: new Date(created.getTime() + approvalTtlMs - 1000) });
    assert.equal(stillValid.status, "consumed", "usable one second before expiry");

    const second = approve(repository, { ...approvalInput, now: created });
    assert.throws(
      () => consume(repository, second, { now: new Date(created.getTime() + approvalTtlMs + 1000) }),
      (error) => error.code === "APPROVAL_EXPIRED",
    );
    assert.equal(repository.getDownloadApproval(second.id).status, "expired", "expiry persists lazily");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("approval is single-use", async () => {
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: { "كراسة الشروط.pdf": "free-available" } });
  try {
    const approval = approve(repository);
    const consumed = consume(repository, approval);
    assert.equal(consumed.status, "consumed");
    assert.ok(consumed.consumedAt);
    assert.throws(
      () => consume(repository, approval),
      (error) => error.code === "APPROVAL_CONSUMED",
    );
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a pending intent is not an approval and confirmation cannot be repeated", async () => {
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: { "كراسة الشروط.pdf": "free-available" } });
  try {
    const intent = repository.requestDownloadApprovalIntent({ tenderReference: tender.reference, files: approvalInput.files });
    assert.equal(intent.status, "pending");
    assert.equal(repository.getDownloadApproval(intent.id), null, "an intent grants no download authority");
    const approval = repository.confirmDownloadApprovalIntent(intent.id, { consentText: downloadConsentPhrase });
    assert.equal(approval.status, "approved");
    assert.throws(
      () => repository.confirmDownloadApprovalIntent(intent.id, { consentText: downloadConsentPhrase }),
      (error) => error.code === "APPROVAL_INTENT_USED",
    );
    assert.throws(
      () => repository.consumeDownloadApproval(approval.id),
      (error) => error.code === "APPROVAL_SCOPE_MISMATCH",
      "consumption always requires the exact manifest",
    );
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a changed manifest fingerprint invalidates the approval", async () => {
  const { projectRoot, repository } = await repositoryWithTender({
    attachmentStates: { "كراسة الشروط.pdf": "free-available", "المخططات.zip": "free-available" },
  });
  try {
    const approval = approve(repository, {
      tenderReference: tender.reference,
      files: [{ displayName: "كراسة الشروط.pdf" }],
      consentText: downloadConsentPhrase,
    });
    assert.throws(
      () => repository.consumeDownloadApproval(approval.id, {
        manifest: { tenderReference: tender.reference, files: [{ displayName: "المخططات.zip", size: null }] },
      }),
      (error) => error.code === "APPROVAL_SCOPE_MISMATCH",
    );
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved", "mismatch does not consume the approval");
    const sameManifest = { tenderReference: tender.reference, files: [{ displayName: "كراسة الشروط.pdf", size: null }] };
    assert.equal(hashDownloadManifest(sameManifest), approval.scopeHash);
    const consumed = repository.consumeDownloadApproval(approval.id, { manifest: sameManifest });
    assert.equal(consumed.status, "consumed", "identical manifest still passes");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("metadata-only, unknown, and restricted files cannot be requested", async () => {
  const { projectRoot, repository } = await repositoryWithTender({
    attachmentStates: {
      "أسماء فقط.pdf": "metadata-only",
      "غير معروف.pdf": "unknown",
      "مقيد.pdf": "restricted",
      "متاح.pdf": "free-available",
    },
  });
  try {
    for (const blocked of ["أسماء فقط.pdf", "غير معروف.pdf", "مقيد.pdf"]) {
      assert.throws(
        () => repository.requestDownloadApprovalIntent({
          tenderReference: tender.reference,
          files: [{ displayName: blocked }],
        }),
        (error) => error.code === "AVAILABILITY_NOT_ALLOWED",
        `${blocked} must be rejected`,
      );
    }
    const approval = approve(repository, {
      tenderReference: tender.reference,
      files: [{ displayName: "متاح.pdf" }],
      consentText: downloadConsentPhrase,
    });
    assert.equal(approval.status, "approved");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("free-available and purchased-available both require explicit consent, and paid booklets require purchase confirmation", async () => {
  const free = await repositoryWithTender({ attachmentStates: { "مجاني.pdf": "free-available" } });
  try {
    const freeIntent = free.repository.requestDownloadApprovalIntent({ tenderReference: tender.reference, files: [{ displayName: "مجاني.pdf" }] });
    assert.throws(
      () => free.repository.confirmDownloadApprovalIntent(freeIntent.id, {}),
      (error) => error.code === "CONSENT_REQUIRED",
      "even free files need the explicit consent phrase",
    );
    assert.throws(
      () => free.repository.confirmDownloadApprovalIntent(freeIntent.id, { consentText: "موافق" }),
      (error) => error.code === "CONSENT_REQUIRED",
      "a paraphrased consent is not accepted",
    );
  } finally {
    free.repository.close();
    await rm(free.projectRoot, { recursive: true, force: true });
  }

  const paid = await repositoryWithTender({ fee: 300, attachmentStates: { "مدفوع.pdf": "purchased-available" } });
  try {
    const paidIntent = paid.repository.requestDownloadApprovalIntent({ tenderReference: tender.reference, files: [{ displayName: "مدفوع.pdf" }] });
    assert.throws(
      () => paid.repository.confirmDownloadApprovalIntent(paidIntent.id, {
        consentText: downloadConsentPhrase,
      }),
      (error) => error.code === "PURCHASE_CONFIRMATION_REQUIRED",
    );
    const approval = paid.repository.confirmDownloadApprovalIntent(paidIntent.id, {
      consentText: downloadConsentPhrase,
      purchaseConfirmed: true,
    });
    assert.equal(approval.status, "approved");
    assert.match(purchaseConsentPhrase, /أتممت شراء الكراسة بنفسي داخل منصة اعتماد/);
  } finally {
    paid.repository.close();
    await rm(paid.projectRoot, { recursive: true, force: true });
  }
});

test("batches above five files are rejected", async () => {
  const names = Object.fromEntries([1, 2, 3, 4, 5, 6].map((index) => [`ملف-${index}.pdf`, "free-available"]));
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: names });
  try {
    assert.throws(
      () => repository.requestDownloadApprovalIntent({
        tenderReference: tender.reference,
        files: Object.keys(names).map((displayName) => ({ displayName })),
      }),
      (error) => error.code === "BATCH_LIMIT_EXCEEDED",
    );
    const five = repository.requestDownloadApprovalIntent({
      tenderReference: tender.reference,
      files: Object.keys(names).slice(0, 5).map((displayName) => ({ displayName })),
    });
    assert.equal(five.scope.files.length, 5, "exactly five files is accepted");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("oversized files, oversized batches, and disallowed formats are rejected", async () => {
  assert.deepEqual(allowedDownloadExtensions, ["pdf", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "zip", "rar", "7z"]);
  const meta = [
    { displayName: "كبير.pdf", availability: "free-available" },
    { displayName: "وسيط-1.pdf", availability: "free-available" },
    { displayName: "وسيط-2.pdf", availability: "free-available" },
    { displayName: "وسيط-3.pdf", availability: "free-available" },
    { displayName: "وسيط-4.pdf", availability: "free-available" },
    { displayName: "برنامج.exe", availability: "free-available" },
    { displayName: "صورة.png", availability: "free-available" },
  ];
  const mb = 1024 * 1024;
  assert.throws(
    () => validateDownloadRequest({ tenderReference: "T", files: [{ displayName: "كبير.pdf", size: 101 * mb }], attachmentsMeta: meta }),
    (error) => error.code === "FILE_TOO_LARGE",
  );
  assert.throws(
    () => validateDownloadRequest({
      tenderReference: "T",
      files: [
        { displayName: "وسيط-1.pdf", size: 100 * mb },
        { displayName: "وسيط-2.pdf", size: 100 * mb },
        { displayName: "وسيط-3.pdf", size: 100 * mb },
        { displayName: "وسيط-4.pdf", size: 100 * mb },
      ],
      attachmentsMeta: meta,
    }),
    (error) => error.code === "BATCH_TOO_LARGE",
    "400MB batch exceeds the 300MB batch limit even when every file is within the per-file limit",
  );
  assert.throws(
    () => validateDownloadRequest({ tenderReference: "T", files: [{ displayName: "برنامج.exe" }], attachmentsMeta: meta }),
    (error) => error.code === "EXTENSION_NOT_ALLOWED",
  );
  assert.throws(
    () => validateDownloadRequest({ tenderReference: "T", files: [{ displayName: "صورة.png" }], attachmentsMeta: meta }),
    (error) => error.code === "EXTENSION_NOT_ALLOWED",
  );
  const accepted = validateDownloadRequest({
    tenderReference: "T",
    files: [
      { displayName: "وسيط-1.pdf", size: 100 * mb },
      { displayName: "وسيط-2.pdf", size: 100 * mb },
      { displayName: "وسيط-3.pdf", size: 100 * mb },
    ],
    attachmentsMeta: meta,
  });
  assert.equal(accepted.files.length, 3, "300MB exactly stays within the batch limit");
});

test("storage paths block traversal, absolute paths, reserved names, and storage escape", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-storage-"));
  try {
    for (const malicious of ["../secret.pdf", "..", "..\\win.pdf", "C:\\temp\\x.pdf", "/etc/passwd", "CON.pdf", "lpt1.pdf", "sub/dir.pdf"]) {
      assert.throws(
        () => resolveAttachmentStoragePath(projectRoot, tender.reference, malicious),
        (error) => error.code === "INVALID_STORAGE_PATH" || error.code === "INVALID_TENDER_REFERENCE",
        `${malicious} must be blocked`,
      );
    }
    assert.throws(() => attachmentTenderDir(projectRoot, "../escape"), (error) => error.code === "INVALID_TENDER_REFERENCE");
    const safe = resolveAttachmentStoragePath(projectRoot, tender.reference, "المخططات.zip");
    assert.ok(safe.startsWith(path.join(projectRoot, ".radar-data", "attachments", tender.reference)));
    assert.match(path.basename(safe), /^[a-f0-9]{64}\.zip$/, "the physical name is generated, not copied from display text");
    assert.notEqual(path.basename(safe), "المخططات.zip");
    assert.throws(() => resolveAttachmentStoragePath(projectRoot, tender.reference, "safe:stream.pdf"), (error) => error.code === "INVALID_STORAGE_PATH");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the production adapter returns DOWNLOAD_ADAPTER_DISABLED and the job records it", async () => {
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: { "كراسة الشروط.pdf": "free-available" } });
  try {
    const approval = approve(repository);
    const job = repository.recordDownloadJob({
      approvalId: approval.id,
      tenderReference: approval.tenderReference,
      manifest: approval.scope,
      status: "running",
    });
    const adapter = createDisabledProductionDownloadAdapter();
    await assert.rejects(
      () => adapter.execute({ id: job.id, manifest: approval.scope }),
      (error) => error.code === "DOWNLOAD_ADAPTER_DISABLED",
    );
    const blocked = repository.updateDownloadJob(job.id, { status: "blocked", errorMessage: "DOWNLOAD_ADAPTER_DISABLED", finished: true });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.errorMessage, "DOWNLOAD_ADAPTER_DISABLED");
    assert.ok(blocked.finishedAt);
    const jobs = repository.listDownloadJobs(tender.reference);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].approvalId, approval.id);
    assert.equal(repository.getDownloadApproval(approval.id).status, "approved", "a disabled adapter never consumes approval authority");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the fake adapter simulates a bounded download inside safe storage for tests only", async () => {
  const { projectRoot, repository } = await repositoryWithTender({ attachmentStates: { "كراسة الشروط.pdf": "free-available" } });
  try {
    const approval = approve(repository);
    const consumed = consume(repository, approval);
    const job = repository.recordDownloadJob({ approvalId: consumed.id, tenderReference: consumed.tenderReference, manifest: consumed.scope, status: "running" });
    const fake = createFakeDownloadAdapter({
      resolvePath: (displayName) => resolveAttachmentStoragePath(projectRoot, tender.reference, displayName),
    });
    const result = await fake.execute({ id: job.id, manifest: consumed.scope });
    assert.equal(result.status, "complete");
    assert.equal(result.files.length, 1);
    const written = await stat(result.files[0]);
    assert.ok(written.size > 0);
    assert.ok(result.files[0].includes(path.join(".radar-data", "attachments", tender.reference)));
    repository.updateDownloadJob(job.id, { status: "complete", finished: true });
    assert.equal(repository.listDownloadJobs(tender.reference)[0].status, "complete");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("service, UI, and gate modules contain no purchase, payment, join, or live download path, and n8n cannot mint approvals", async () => {
  const [service, page, gate, adapters, storage, workflow] = await Promise.all([
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/lib/download-gate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/lib/attachment-adapters.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/lib/attachment-storage.mjs", import.meta.url), "utf8"),
    readFile(new URL("../automation/n8n/radar-phase-1.workflow.json", import.meta.url), "utf8"),
  ]);
  for (const source of [service, page, gate, adapters, storage]) {
    assert.doesNotMatch(source, /\.download\(/);
    assert.doesNotMatch(source, /purchase\(|\/payment|checkout|submitOffer|joinTender/i);
  }
  for (const source of [gate, adapters, storage]) {
    assert.doesNotMatch(source, /challenges\.cloudflare|cf-clearance/i, "the download path must not touch challenge cookies or solvers");
  }
  assert.doesNotMatch(service, /\/purchase\b|\/pay\b/i);
  assert.match(service, /DOWNLOAD_ADAPTER_DISABLED/);
  assert.match(service, /requestDownloadApprovalIntent/);
  assert.match(service, /confirmDownloadApprovalIntent/);
  assert.match(service, /HUMAN_CONFIRMATION_ORIGIN_REQUIRED/);
  assert.doesNotMatch(service, /pathname === "\/approvals"/);
  const jobRoute = service.slice(service.indexOf('pathname === "/approval-jobs"'), service.indexOf('pathname === "/approval-jobs"') + 2200);
  assert.doesNotMatch(jobRoute, /consumeDownloadApproval/, "the disabled B0 route must not consume a usable approval");
  assert.doesNotMatch(service, /launchPersistentContext|page\.download/);
  assert.doesNotMatch(workflow, /approvals|download_jobs|approval-jobs/i, "n8n must not reach the approval surface");
  assert.match(page, /طلب تنزيل الملفات/);
  assert.match(page, /أوافق على تنزيل الملفات المحددة الآن من هذه المنافسة فقط/);
  assert.match(page, /أؤكد أنني أتممت شراء الكراسة بنفسي داخل منصة اعتماد/);
  assert.match(page, /التنفيذ الحي غير مفعّل في P3-B0/);
  assert.match(page, /\/approval-intents/);
  assert.doesNotMatch(page, /fetch\(`\$\{syncServiceUrl\}\/approval-jobs/);
});
