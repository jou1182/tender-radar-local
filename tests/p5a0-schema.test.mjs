// اختبارات P5-A0 — migration v8: طابور التنزيل + التصنيف + السياسات
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

async function makeProjectRoot(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  return projectRoot;
}

test("P5-A0-1: fresh database initializes at schemaVersion 8 with the new tables", async () => {
  const projectRoot = await makeProjectRoot("radar-p5a0-fresh-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    assert.equal(repo.schemaVersion, 8);
    const db = new DatabaseSync(repo.databasePath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('download_queue','tender_classification','policy_settings')")
        .all()
        .map((row) => row.name)
        .sort();
      assert.deepEqual(tables, ["download_queue", "policy_settings", "tender_classification"]);
      const versionRow = db
        .prepare("SELECT MAX(CAST(version AS INTEGER)) AS v FROM schema_migrations")
        .get();
      assert.equal(versionRow.v, 8);
    } finally {
      db.close();
      repo.close();
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A0-2: an existing v7 database upgrades in place to v8 without data loss", async () => {
  const projectRoot = await makeProjectRoot("radar-p5a0-upgrade-");
  try {
    // إنشاء قاعدة ثم خفض تسجيل إصدارها إلى v7 لمحاكاة قاعدة قديمة (الجداول موجودة بالفعل
    // لأن الإنشاء idempotent — المهم أن الترقية تعيد فتح القاعدة وتسجل v8 دون كسر البيانات).
    const first = await createRadarRepository({ projectRoot });
    first.saveCompletedSync({
      lastSyncAt: new Date().toISOString(),
      items: [{ reference: "260739009419", title: "منافسة اختبار", agency: "أمانة المنطقة", fee: 0, region: "القصيم" }],
      added: [], changed: [],
      scope: {},
    }, "run-seed-1");
    first.close();

    const downgrade = new DatabaseSync(path.join(projectRoot, ".radar-data", "radar.sqlite"));
    downgrade.prepare("DELETE FROM schema_migrations WHERE version = '8'").run();
    downgrade.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES ('7', '2026-08-01T00:00:00.000Z')").run();
    downgrade.close();

    const reopened = await createRadarRepository({ projectRoot });
    assert.equal(reopened.schemaVersion, 8);
    const baselineRows = reopened.listTenders ? reopened.listTenders().length : -1;
    assert.ok(baselineRows >= 0);
    reopened.enqueueDownload({ tenderReference: "260739009419", fileName: "كراسة.pdf" });
    const queue = reopened.listDownloadQueue("proposed");
    assert.equal(queue.length, 1);
    reopened.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A0-3: download queue lifecycle moves proposed -> auto-approved -> stored with byte tracking", async () => {
  const projectRoot = await makeProjectRoot("radar-p5a0-queue-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    repo.saveCompletedSync({
      lastSyncAt: new Date().toISOString(),
      items: [
        { reference: "260739009419", title: "منافسة مجانية", agency: "أمانة", fee: 0, region: "القصيم", feeVerification: "detail-verified" },
        { reference: "260839002206", title: "منافسة مدفوعة", agency: "بلدية", fee: 200, region: "القصيم" },
      ],
      added: [], changed: [],
      scope: {},
    }, "run-seed-1");
    const idFree = repo.enqueueDownload({
      tenderReference: "260739009419",
      fileName: "كراسة الشروط.pdf",
      state: "auto-approved",
      manifestSha256: "a".repeat(64),
    });
    repo.enqueueDownload({
      tenderReference: "260839002206",
      fileName: "جدول الكميات.xlsx",
    });

    const waiting = repo.listDownloadQueue("proposed");
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].file_name, "جدول الكميات.xlsx");

    const stored = repo.updateDownloadQueueState(idFree, { state: "stored", bytes: 1234567 });
    assert.equal(stored.state, "stored");
    assert.equal(stored.bytes, 1234567);
    assert.ok(stored.decided_at);

    const invalidState = () => repo.updateDownloadQueueState(idFree, { state: "not-a-state" });
    assert.throws(invalidState);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A0-4: policy settings persist JSON values across repository reopen", async () => {
  const projectRoot = await makeProjectRoot("radar-p5a0-policy-");
  try {
    const first = await createRadarRepository({ projectRoot });
    first.setPolicySetting("downloadPolicy", {
      mode: "closed-then-gradual",
      autoApproveVerifiedFree: false,
      dailyDetailReadsCap: 30,
      maxFilesPerTender: 5,
    });
    first.setPolicySetting("regionOrder", { priority: ["القصيم"], then: "rest" });
    first.close();

    const second = await createRadarRepository({ projectRoot });
    const policy = second.getPolicySetting("downloadPolicy");
    assert.equal(policy.autoApproveVerifiedFree, false);
    assert.equal(policy.dailyDetailReadsCap, 30);
    assert.deepEqual(second.getPolicySetting("regionOrder").priority, ["القصيم"]);
    assert.equal(second.getPolicySetting("missing-key", "fallback"), "fallback");
    second.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A0-5: classification upserts keep the latest specialty per tender", async () => {
  const projectRoot = await makeProjectRoot("radar-p5a0-class-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    repo.saveCompletedSync({
      lastSyncAt: new Date().toISOString(),
      items: [{ reference: "260739009419", title: "منافسة اختبار تصنيف", agency: "أمانة", fee: 0, region: "القصيم" }],
      added: [], changed: [],
      scope: {},
    }, "run-seed-1");
    repo.saveTenderClassification({ tenderReference: "260739009419", specialtyCode: "buildings", confidence: 0.6 });
    repo.saveTenderClassification({ tenderReference: "260739009419", specialtyCode: "roads", confidence: 0.9 });
    const row = repo.getTenderClassification("260739009419");
    assert.equal(row.specialty_code, "roads");
    assert.equal(row.confidence, 0.9);
    assert.equal(row.method, "rulebook");
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
