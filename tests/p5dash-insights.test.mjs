// اختبارات P5-DASH — لوحة الرؤى: last-run / regions / storage / purge
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RADAR_DB_ROOT = await mkdtemp(path.join(os.tmpdir(), "radar-p5dash-"));
process.env.RADAR_SYNC_PORT = "0";
process.env.N8N_RADAR_WEBHOOK_URL = "http://127.0.0.1:9/x";

const mod = await import("../scripts/etimad-sync-service.mjs");
const server = mod.getSyncServer();
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

const { DatabaseSync } = await import("node:sqlite");
const { utimesSync } = await import("node:fs");

function seedCompletedRun() {
  // بذر جولة مكتملة + منطقتين + منافستين مباشرة في القاعدة المعزولة
  const root = process.env.RADAR_DB_ROOT;
  const db = new DatabaseSync(path.join(root, ".radar-data", "radar.sqlite"));
  const runId = "sync-test-dash-1";
  db.prepare(`INSERT INTO sync_runs (id, started_at, finished_at, status, regions_targeted, regions_completed, target_per_region, checked_count, new_count, changed_count)
              VALUES (?, ?, ?, 'complete', 13, 13, 100, 315, 38, 17)`).run(runId, "2026-08-27T18:50:43.421Z", "2026-08-27T18:53:40.364Z");
  db.prepare("INSERT INTO sync_regions (sync_run_id, region_id, region_name, status, checked_count) VALUES (?, '1', 'منطقة الرياض', 'complete', 100)").run(runId);
  db.prepare("INSERT INTO sync_regions (sync_run_id, region_id, region_name, status, checked_count) VALUES (?, '8', 'منطقة القصيم', 'complete', 3)").run(runId);
  db.prepare(`INSERT INTO tenders (reference, title, agency, fee, region, deadline, first_seen_at, last_seen_at) VALUES ('260000000001', 'منافسة الرياض', 'أمانة', 0, 'منطقة الرياض', '2026-09-01', '2026-08-27T18:50:43.421Z', '2026-08-27T18:50:43.421Z')`).run();
  db.prepare(`INSERT INTO tenders (reference, title, agency, fee, region, deadline, first_seen_at, last_seen_at) VALUES ('260000000002', 'منافسة القصيم', 'أمانة', 200, 'منطقة القصيم', '2026-09-01', '2026-08-27T18:50:43.421Z', '2026-08-27T18:50:43.421Z')`).run();
  db.close();
}

test("P5-DASH-1: last-run returns full summary for a completed run", async () => {
  seedCompletedRun();
  const data = await fetch(`${base}/dashboard/last-run`).then((r) => r.json());
  assert.equal(data.available, true);
  assert.equal(data.status, "complete");
  assert.equal(data.complete, true);
  assert.equal(data.newCount, 38);
  assert.equal(data.changedCount, 17);
  assert.equal(data.regionsCompleted, 13);
  assert.ok(data.durationLabel.includes("دقيقتين") || data.durationLabel.includes("دقيقة"), data.durationLabel);
  assert.ok(data.topRegions.some((r) => r.name === "منطقة الرياض" && r.checked === 100));
});

test("P5-DASH-2: regions returns sortable stats with القصيم present", async () => {
  const data = await fetch(`${base}/dashboard/regions`).then((r) => r.json());
  assert.equal(data.total, 2);
  const qassim = data.single.find((r) => r.region.includes("القصيم"));
  assert.ok(qassim, "القصيم موجودة");
  assert.equal(qassim.count, 1);
});

test("P5-DASH-3: storage overview + purge dry-run/confirm on isolated files", async () => {
  // ملف قديم (40 يومًا) + ملف حديث
  const attDir = path.join(process.env.RADAR_DB_ROOT, ".radar-data", "attachments", "260000000001");
  await mkdir(attDir, { recursive: true });
  const oldPath = path.join(attDir, "old.pdf");
  const newPath = path.join(attDir, "new.pdf");
  await writeFile(oldPath, "old-content");
  await writeFile(newPath, "new-content");
  const past = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(oldPath, past, past);

  const db = new DatabaseSync(path.join(process.env.RADAR_DB_ROOT, ".radar-data", "radar.sqlite"));
  db.prepare(`INSERT INTO attachments (tender_reference, display_name, download_status, local_path, size, availability_updated_at)
              VALUES ('260000000001', 'كراسة قديمة', 'downloaded', ?, 11, ?)`).run(oldPath, past.toISOString());
  db.prepare(`INSERT INTO attachments (tender_reference, display_name, download_status, local_path, size, availability_updated_at)
              VALUES ('260000000001', 'كراسة حديثة', 'downloaded', ?, 10, ?)`).run(newPath, new Date().toISOString());
  db.close();

  const overview = await fetch(`${base}/dashboard/storage`).then((r) => r.json());
  assert.equal(overview.count, 2);

  // معاينة: 1 ملف فقط (القديم)
  const dry = await fetch(`${base}/dashboard/storage/purge`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ olderThanDays: 30 }),
  }).then((r) => r.json());
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldDelete, 1);

  // تأكيد: يحذف القديم فقط من القرص ومن local_path
  const real = await fetch(`${base}/dashboard/storage/purge`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ olderThanDays: 30, confirm: true }),
  }).then((r) => r.json());
  assert.equal(real.deleted, 1);
  assert.ok(real.freedBytes >= 11);

  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(oldPath), false, "الملف القديم حُذف من القرص");
  assert.equal(existsSync(newPath), true, "الملف الحديث بقي");

  const after = await fetch(`${base}/dashboard/storage`).then((r) => r.json());
  assert.equal(after.count, 1);
});
