import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultSearchProfile, seedActivities, seedSubActivities } from "../scripts/lib/activity-catalog-seed.mjs";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { advanceCursor, defaultPlan, initialCursor, planFromSearchProfile, regions } from "../scripts/lib/sync-plan.mjs";

const tender = {
  id: "260000000030",
  reference: "260000000030",
  title: "منافسة من v3",
  agency: "جهة اختبار",
  fee: 0,
  region: "منطقة الرياض",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=p3",
  score: 70,
  remoteAttachments: [],
};

async function freshRepository(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

test("Schema v7 migration preserves live tenders, details, and attachments from a v3 database", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-v3-"));
  let repository;
  try {
    const privateDir = path.join(projectRoot, ".radar-data");
    await mkdir(privateDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(privateDir, "radar.sqlite"));
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-08-13T10:00:00.000Z');
      CREATE TABLE tenders (
        reference TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agency TEXT NOT NULL,
        fee INTEGER NOT NULL DEFAULT 0,
        region TEXT NOT NULL,
        deadline TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '',
        platform_status TEXT NOT NULL DEFAULT '',
        activity TEXT NOT NULL DEFAULT '',
        sub_activity TEXT NOT NULL DEFAULT '',
        tender_type TEXT NOT NULL DEFAULT '',
        etimad_url TEXT NOT NULL DEFAULT '',
        tender_number TEXT NOT NULL DEFAULT '',
        contract_duration TEXT NOT NULL DEFAULT '',
        guarantee TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        quantity_summary TEXT NOT NULL DEFAULT '',
        attachment_names_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO tenders (reference, title, agency, fee, region, deadline, published_at, platform_status, activity, first_seen_at, last_seen_at)
        VALUES ('260000000030', 'منافسة من v3', 'جهة اختبار', 0, 'منطقة الرياض', '2026-09-01 09:59', '2026-08-13', 'المنافسات النشطة (تقديم العروض)', 'المقاولات', '2026-08-13T10:00:00.000Z', '2026-08-13T10:00:00.000Z');
      CREATE TABLE tender_details (
        tender_reference TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        inspected_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        page_title TEXT NOT NULL DEFAULT '',
        fields_json TEXT NOT NULL DEFAULT '{}',
        sections_json TEXT NOT NULL DEFAULT '[]',
        attachment_names_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        error_message TEXT
      );
      INSERT INTO tender_details (tender_reference, status, inspected_at, source_url, page_title, fields_json, sections_json, attachment_names_json, content_hash)
        VALUES ('260000000030', 'complete', '2026-08-13T10:05:00.000Z', 'https://tenders.etimad.sa/Tender/Details?STenderId=p3', 'تفاصيل المنافسة', '{"tenderNumber":"T-30"}', '[{"name":"المعلومات الأساسية","text":"رقم المنافسة: T-30"}]', '[{"displayName":"كراسة الشروط.pdf","kind":"booklet"}]', 'hash-v3');
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tender_reference TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'supporting',
        remote_visible INTEGER NOT NULL DEFAULT 1,
        download_status TEXT NOT NULL DEFAULT 'not-downloaded',
        local_path TEXT,
        sha256 TEXT,
        mime_type TEXT,
        size INTEGER,
        UNIQUE (tender_reference, display_name)
      );
      INSERT INTO attachments (tender_reference, display_name, kind) VALUES ('260000000030', 'كراسة الشروط.pdf', 'booklet');
    `);
    legacy.close();

    repository = await createRadarRepository({ projectRoot });
    assert.equal(repository.schemaVersion, 7);
    const stored = repository.getTender("260000000030");
    assert.equal(stored.title, "منافسة من v3");
    assert.equal(stored.feeVerification, "unknown");
    assert.equal(stored.details.status, "complete");
    assert.equal(stored.details.fields.tenderNumber, "T-30");
    assert.deepEqual(stored.remoteAttachments, ["كراسة الشروط.pdf"]);
    const meta = repository.listAttachmentMeta("260000000030");
    assert.equal(meta.length, 1);
    assert.equal(meta[0].displayName, "كراسة الشروط.pdf");
    assert.equal(meta[0].availability, "unknown", "v3 rows keep the unknown availability default");
    assert.equal(meta[0].requiresApproval, true);
    assert.equal(repository.listActivityCatalog().length, 19);

    repository.close();
    repository = await createRadarRepository({ projectRoot });
    const reopened = repository.getTender("260000000030");
    assert.equal(reopened.title, "منافسة من v3", "reopening the migrated database keeps live data");
    assert.equal(reopened.details.fields.tenderNumber, "T-30");
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("activity catalog seeds exactly 19 unique primary activities with no duplication", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-catalog-");
  try {
    const catalog = repository.listActivityCatalog();
    assert.equal(catalog.length, 19);
    assert.equal(new Set(catalog.map((item) => item.name)).size, 19);
    assert.deepEqual(catalog.map((item) => item.name), seedActivities);
    assert.ok(catalog.every((item) => item.source === "seed"));
    assert.equal(catalog.find((item) => item.name === "المقاولات")?.etimadValue, "2");
    assert.ok(catalog.filter((item) => item.name !== "المقاولات").every((item) => item.etimadValue === null));
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("contracting owns the confirmed sub-activities and other sectors get no invented data", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-subs-");
  try {
    const catalog = repository.listActivityCatalog();
    const contracting = catalog.find((item) => item.name === "المقاولات");
    assert.equal(contracting.subActivities.length, 5);
    assert.equal(new Set(contracting.subActivities.map((sub) => sub.name)).size, 5, "no textual duplication");
    assert.deepEqual(contracting.subActivities.map((sub) => sub.name), seedSubActivities["المقاولات"]);
    for (const other of catalog.filter((item) => item.name !== "المقاولات")) {
      assert.deepEqual(other.subActivities, [], `${other.name} must not get invented sub-activities`);
    }
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("search profiles save, read, update, and enforce safe constraints", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-profiles-");
  try {
    const created = repository.createSearchProfile({
      name: "ملف اختبار",
      activityName: "المقاولات",
      subActivityNames: ["إنشاء الطرق", "إنشاءات عامة", "إنشاء الطرق"],
      regionIds: ["1", "4", "99", "1"],
      platformStatuses: ["المنافسات النشطة (تقديم العروض)"],
      feeMin: 0,
      feeMax: 300,
      targetPerRegion: 50,
      enabled: false,
    });
    assert.ok(created.id);
    assert.deepEqual(created.subActivityNames, ["إنشاء الطرق", "إنشاءات عامة"], "duplicate sub-activities collapse");
    assert.deepEqual(created.regionIds, ["1", "4"], "unknown and duplicate region ids drop out");

    const listed = repository.listSearchProfiles().find((profile) => profile.id === created.id);
    assert.deepEqual(listed.subActivityNames, ["إنشاء الطرق", "إنشاءات عامة"]);
    assert.equal(listed.targetPerRegion, 50);

    assert.throws(
      () => repository.updateSearchProfile(created.id, { feeMax: 500, enabled: true }),
      /الأنشطة الفرعية/,
      "a saved sub-activity filter must never be silently ignored by live sync",
    );
    const syncReady = repository.createSearchProfile({
      name: "ملف مزامنة آمن",
      activityName: "المقاولات",
      subActivityNames: [],
      regionIds: ["1", "4"],
      platformStatuses: ["المنافسات النشطة (تقديم العروض)"],
      feeMin: 0,
      feeMax: 500,
      targetPerRegion: 50,
      enabled: true,
    });
    assert.equal(syncReady.enabled, true);
    assert.equal(syncReady.syncReady, true);
    assert.equal(repository.getEnabledSearchProfile().id, syncReady.id, "only one safe profile stays enabled");
    assert.equal(repository.updateSearchProfile("profile-missing", { name: "لا يوجد" }), null);

    assert.throws(
      () => repository.createSearchProfile({ name: "ملف مخترع", activityName: "التجارة", subActivityNames: ["نشاط فرعي مخترع"] }),
      /غير معروف/,
    );
    assert.throws(
      () => repository.createSearchProfile({ name: "ملف اختبار", activityName: "المقاولات" }),
      /مستخدم بالفعل/,
    );
    assert.throws(
      () => repository.createSearchProfile({ name: "ملف أسعار مقلوبة", activityName: "المقاولات", feeMin: 600, feeMax: 100 }),
      /الحد الأعلى/,
    );
    const clamped = repository.createSearchProfile({ name: "ملف سقف النتائج", activityName: "المقاولات", targetPerRegion: 900 });
    assert.equal(clamped.targetPerRegion, 100, "target per region stays capped at 100");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the default profile reproduces the exact current P1 scope", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-default-");
  try {
    const profile = repository.getEnabledSearchProfile();
    assert.equal(profile.id, "profile-default");
    assert.equal(profile.name, defaultSearchProfile.name);
    assert.equal(profile.activityName, "المقاولات");
    assert.deepEqual(profile.subActivityNames, []);
    assert.deepEqual(profile.regionIds, regions.map((region) => region.id));
    assert.deepEqual(profile.platformStatuses, ["المنافسات النشطة (تقديم العروض)"]);
    assert.equal(profile.feeMin, 0);
    assert.equal(profile.feeMax, 600);
    assert.equal(profile.targetPerRegion, 100);
    assert.equal(profile.enabled, true);

    const plan = planFromSearchProfile(profile);
    assert.equal(plan.regions.length, 13);
    assert.deepEqual(plan.feeBuckets.map((bucket) => bucket.id), ["free", "paid-1-1000"]);
    assert.equal(plan.targetPerRegion, 100);
    assert.equal(plan.activityValue, "2");

    const simulate = (activePlan) => {
      let cursor = initialCursor(activePlan);
      const steps = [];
      for (const batchSize of [24, 24, 24, 24, 4]) {
        cursor = advanceCursor(cursor, { batchSize, hasNextPage: true }, activePlan);
        steps.push([cursor.regionIndex, cursor.feeIndex, cursor.pageNumber, cursor.regionChecked, cursor.checked]);
      }
      return steps;
    };
    assert.deepEqual(simulate(plan), simulate(defaultPlan), "profile-driven plan matches the P1 cursor behavior exactly");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("selecting a primary activity changes the available sub-activities", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-select-");
  try {
    const catalog = repository.listActivityCatalog();
    const subActivitiesFor = (activityName) => catalog.find((item) => item.name === activityName)?.subActivities.map((sub) => sub.name) ?? [];
    assert.deepEqual(subActivitiesFor("المقاولات"), seedSubActivities["المقاولات"]);
    assert.deepEqual(subActivitiesFor("التجارة"), []);
    assert.deepEqual(subActivitiesFor("التعليم والتدريب"), []);
    assert.deepEqual(subActivitiesFor("نشاط غير موجود"), []);
    assert.notDeepEqual(subActivitiesFor("المقاولات"), subActivitiesFor("الأمن والسلامة"));
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("attachment availability states save and render without any download path", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-availability-");
  try {
    const runId = repository.startSyncRun();
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T18:00:00.000Z", checked: 1, regions: 13, targetPerRegion: 100,
      added: [{ ...tender, remoteAttachments: ["المخططات.zip"] }],
      changed: [],
      items: [{ ...tender, remoteAttachments: ["المخططات.zip"] }],
    }, runId);

    let meta = repository.listAttachmentMeta(tender.reference);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].availability, "metadata-only", "captured names stay metadata-only by default");
    assert.equal(meta[0].requiresApproval, true);

    meta = repository.setAttachmentAvailability(tender.reference, "المخططات.zip", "free-available");
    assert.equal(meta[0].availability, "free-available");
    assert.throws(
      () => repository.setAttachmentAvailability(tender.reference, "المخططات.zip", "حالة-مخترعة"),
      /غير معروفة/,
    );

    repository.saveVisibleAttachmentNames(tender.reference, ["المخططات.zip"]);
    meta = repository.listAttachmentMeta(tender.reference);
    assert.equal(meta[0].availability, "free-available", "a later name capture never downgrades a known availability state");

    const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(service, /\/attachments\/download|\/files\/download|\/download\b/);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("service and UI contain no real purchase, payment, or download path", async () => {
  const [service, page] = await Promise.all([
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [service, page]) {
    assert.doesNotMatch(source, /\.download\(/);
    assert.doesNotMatch(source, /purchase\(|\/payment|checkout/i);
    assert.doesNotMatch(source, /submitOffer|joinTender/i);
  }
  assert.doesNotMatch(service, /\/purchase\b|\/pay\b/i);
  assert.match(page, /لا تنزيل قبل موافقة المستخدم/);
  assert.match(page, /التنفيذ الحي غير مفعّل في P3-B0/);
  assert.match(page, /مركز المرفقات/);
});

test("the UI reads the catalog and search profiles from the local service, not static JSX arrays", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/catalog\/activities/);
  assert.match(page, /\/search-profiles/);
  assert.match(page, /aria-pressed/);
  assert.doesNotMatch(page, /const activityOptions/);
  assert.doesNotMatch(page, /const subActivityOptions/);
  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  assert.match(service, /pathname === "\/catalog\/activities"/);
  assert.match(service, /pathname === "\/search-profiles"/);
  assert.match(service, /pathname\.startsWith\("\/search-profiles\/"\)/);
  assert.match(service, /getEnabledSearchProfile/);
});
