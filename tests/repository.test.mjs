import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

function result(items, overrides = {}) {
  return {
    lastSyncAt: overrides.lastSyncAt || "2026-08-13T12:00:00.000Z",
    checked: items.length,
    regions: 13,
    targetPerRegion: 100,
    added: overrides.added || items,
    changed: overrides.changed || [],
    items,
  };
}

const tender = {
  id: "260000000001",
  reference: "260000000001",
  title: "صيانة مبنى خدمي",
  agency: "جهة اختبار",
  fee: 200,
  region: "منطقة القصيم",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  status: "جديدة",
  documents: "لم تُفتح",
  score: 72,
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=test",
  remoteAttachments: ["الشروط الخاصة.pdf"],
};

test("SQLite is the durable source for tenders, sync runs, and changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "tender-radar-db-"));
  let repository;
  try {
    repository = await createRadarRepository({ projectRoot });
    repository.seedBaseline(["260000000000"]);
    assert.equal(repository.listTenders().length, 0, "baseline references must not appear as live tenders");

    const firstRun = repository.startSyncRun();
    repository.saveCompletedSync(result([tender]), firstRun);
    let snapshot = repository.getDashboardSnapshot();
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].title, tender.title);
    assert.deepEqual(snapshot.items[0].remoteAttachments, tender.remoteAttachments);
    assert.equal(snapshot.newItems, 1);

    const changedTender = { ...tender, title: "صيانة وترميم مبنى خدمي", fee: 500 };
    const secondRun = repository.startSyncRun();
    repository.saveCompletedSync(result([changedTender], { lastSyncAt: "2026-08-13T13:00:00.000Z", added: [], changed: [changedTender] }), secondRun);
    snapshot = repository.getDashboardSnapshot();
    assert.equal(snapshot.items[0].title, changedTender.title);
    assert.equal(snapshot.items[0].fee, 500);
    assert.equal(snapshot.changedItems, 1);
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("production UI does not seed historical or demo tenders", async () => {
  const [page, demo, legacy, service] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/demo-tenders.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/legacy-observed-tenders.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /useState<Tender\[\]>\(\[\]\)/);
  assert.match(page, /\/tenders/);
  assert.match(page, /showDemoData/);
  assert.match(demo, /DEMO-001/);
  assert.doesNotMatch(legacy, /DEMO-001/);
  assert.match(service, /createRadarRepository/);
  assert.doesNotMatch(service, /etimad-sync\.json/);
});

test("Arabic source files stay valid UTF-8 without mojibake markers", async () => {
  const sources = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/demo-tenders.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/legacy-observed-tenders.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /Ø§|Øª|Ù„|Ù…|Ã|â€|\uFFFD/);
    assert.match(source, /[\u0600-\u06FF]/);
  }
});
