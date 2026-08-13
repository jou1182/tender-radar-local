import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { advanceCursor, initialCursor, pagesNeeded, targetPerRegion } from "../scripts/lib/sync-plan.mjs";

test("sync plan caps a region at 100 appearances across 24-item pages", () => {
  let cursor = initialCursor();
  for (const size of [24, 24, 24, 24]) cursor = advanceCursor(cursor, { batchSize: size, hasNextPage: true });
  assert.equal(cursor.pageNumber, 5);
  assert.equal(cursor.regionChecked, 96);
  cursor = advanceCursor(cursor, { batchSize: 4, hasNextPage: true });
  assert.equal(cursor.regionIndex, 1);
  assert.equal(cursor.regionChecked, 0);
  assert.equal(cursor.checked, targetPerRegion);
  assert.equal(pagesNeeded(), 5);
});

test("sync plan visits the paid bucket when the free bucket has no more pages", () => {
  const next = advanceCursor(initialCursor(), { batchSize: 0, hasNextPage: false });
  assert.equal(next.regionIndex, 0);
  assert.equal(next.feeIndex, 1);
  assert.equal(next.feeBucket, "paid-1-1000");
  assert.equal(next.pageNumber, 1);
});

test("SQLite resumes a partial run and does not publish its draft as the live snapshot", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p1-"));
  let repository;
  try {
    repository = await createRadarRepository({ projectRoot });
    const started = repository.startOrResumeSyncRun({ initialCursor: initialCursor() });
    const nextCursor = advanceCursor(initialCursor(), { batchSize: 1, hasNextPage: true });
    repository.saveSyncCheckpoint(started.id, {
      regionId: "1",
      regionName: "منطقة الرياض",
      feeBucket: "free",
      pageNumber: 1,
      checked: 1,
      regionChecked: 1,
      items: [{ reference: "260000000001", title: "اختبار", fee: 0, regionName: "منطقة الرياض" }],
      nextCursor,
    });
    repository.markSyncPartial(started.id, { cursor: nextCursor, error: new Error("LOGIN_REQUIRED") });
    assert.equal(repository.getDashboardSnapshot().items.length, 0);
    assert.equal(repository.getDashboardSnapshot().lastSyncAt, null);
    repository.close();
    repository = undefined;

    repository = await createRadarRepository({ projectRoot });
    const resumed = repository.startOrResumeSyncRun({ initialCursor: initialCursor() });
    assert.equal(resumed.id, started.id);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.cursor.pageNumber, 2);
    assert.equal(repository.loadDraftObservations(started.id).length, 1);
    assert.equal(repository.getSyncProgress().status, "partial");
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("browser login remains human and sync contains no bypass, purchase, or download path", async () => {
  const [browserSource, serviceSource] = await Promise.all([
    readFile(new URL("../scripts/lib/radar-chrome-session.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(browserSource, /remote-debugging-port/);
  assert.match(browserSource, /connectOverCDP/);
  assert.doesNotMatch(browserSource, /launchPersistentContext|enable-automation|navigator\.webdriver/);
  assert.match(serviceSource, /CAPTCHA_REQUIRED/);
  assert.match(serviceSource, /request\.url === "\/details"/);
  assert.match(serviceSource, /saveVisibleAttachmentNames/);
  assert.doesNotMatch(serviceSource, /download\(|purchase|شراء|submitOffer|joinTender|cookies\(\)/i);
});
