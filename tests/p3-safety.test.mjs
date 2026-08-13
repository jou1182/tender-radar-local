import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { defaultPlan, initialCursor, planFromSearchProfile } from "../scripts/lib/sync-plan.mjs";

async function freshRepository(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repository = await createRadarRepository({ projectRoot });
  return { projectRoot, repository };
}

function tender(reference, activity, title = `Tender ${reference}`) {
  return {
    id: reference,
    reference,
    title,
    agency: "Test agency",
    fee: 0,
    region: "منطقة الرياض",
    deadline: "2026-09-01 09:59",
    publishedAt: "2026-08-13",
    platformStatus: "المنافسات النشطة (تقديم العروض)",
    activity,
    etimadUrl: `https://tenders.etimad.sa/Tender/Details?STenderId=${reference}`,
    score: 70,
    remoteAttachments: [],
  };
}

test("P3 safety: unsupported live filters are saved but cannot be activated or planned", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-safe-profile-");
  try {
    assert.throws(
      () => repository.createSearchProfile({ name: "No activity" }),
      /نشاطًا أساسيًا/,
    );

    const unknownActivity = repository.createSearchProfile({
      name: "Trade local only",
      activityName: "التجارة",
      platformStatuses: ["المنافسات النشطة (تقديم العروض)"],
    });
    assert.equal(unknownActivity.syncReady, false);
    assert.throws(
      () => repository.updateSearchProfile(unknownActivity.id, { enabled: true }),
      /قيمة النشاط/,
    );

    const unsupportedStatus = repository.createSearchProfile({
      name: "Award stage local only",
      activityName: "المقاولات",
      platformStatuses: ["مرحلة الترسية"],
    });
    assert.equal(unsupportedStatus.syncReady, false);
    assert.throws(
      () => repository.updateSearchProfile(unsupportedStatus.id, { enabled: true }),
      /المنافسات النشطة/,
    );

    assert.throws(
      () => planFromSearchProfile({
        id: "sub-filter",
        activityName: "المقاولات",
        activityEtimadValue: "2",
        subActivityNames: ["إنشاء الطرق"],
        subActivityEtimadValues: ["known-later"],
        platformStatuses: ["المنافسات النشطة (تقديم العروض)"],
      }),
      /الأنشطة الفرعية/,
      "sub-activity selection must not be ignored even if a future value exists",
    );
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P3 safety: a partial cursor is resumed only inside the exact same search scope", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-safe-resume-");
  try {
    const firstCursor = initialCursor(defaultPlan);
    const first = repository.startOrResumeSyncRun({ initialCursor: firstCursor });
    repository.markSyncPartial(first.id, { cursor: firstCursor, error: new Error("LOGIN_REQUIRED") });

    const changedPlan = { ...defaultPlan, scopeKey: "profile:another-scope" };
    const second = repository.startOrResumeSyncRun({ initialCursor: initialCursor(changedPlan) });
    assert.notEqual(second.id, first.id);
    assert.equal(second.resumed, false);
    assert.equal(second.cursor.scopeKey, changedPlan.scopeKey);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P3 safety: scoped sync never deactivates unrelated sectors or unseen rows", async () => {
  const { projectRoot, repository } = await freshRepository("radar-p3-safe-snapshot-");
  try {
    const contractingOne = tender("260000000201", "المقاولات");
    const contractingTwo = tender("260000000202", "المقاولات");
    const trade = tender("260000000203", "التجارة");

    let runId = repository.startSyncRun();
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T20:00:00.000Z",
      checked: 3,
      regions: 13,
      targetPerRegion: 100,
      items: [contractingOne, contractingTwo, trade],
      added: [contractingOne, contractingTwo, trade],
      changed: [],
      scope: { activity: "المقاولات", replacesActivitySnapshot: false },
    }, runId);

    runId = repository.startSyncRun({ regions: 1, targetPerRegion: 10 });
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T20:05:00.000Z",
      checked: 1,
      regions: 1,
      targetPerRegion: 10,
      items: [{ ...contractingOne, title: "Scoped update" }],
      added: [],
      changed: [],
      scope: { activity: "المقاولات", replacesActivitySnapshot: false },
    }, runId);
    assert.equal(repository.getTender(contractingTwo.reference).active, true);
    assert.equal(repository.getTender(trade.reference).active, true);

    runId = repository.startSyncRun();
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T20:10:00.000Z",
      checked: 1,
      regions: 13,
      targetPerRegion: 100,
      items: [contractingOne],
      added: [],
      changed: [],
      scope: { activity: "المقاولات", replacesActivitySnapshot: true },
    }, runId);
    assert.equal(repository.getTender(contractingTwo.reference).active, false);
    assert.equal(repository.getTender(trade.reference).active, true, "another activity remains untouched");
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
