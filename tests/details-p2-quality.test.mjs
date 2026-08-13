import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessDetailCompleteness,
  buildDetailRecord,
  isVisibleAttachmentName,
  selectVisibleAttachmentNames,
  shouldRetryDetailRead,
} from "../scripts/lib/etimad-detail-parser.mjs";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

const attachmentFixture = JSON.parse(await readFile(new URL("./fixtures/visible-attachment-candidates.fixture.json", import.meta.url), "utf8"));
const tabsFixture = JSON.parse(await readFile(new URL("./fixtures/partial-detail-tabs.fixture.json", import.meta.url), "utf8"));

const tender = {
  id: "260000000100",
  reference: "260000000100",
  title: "منافسة إصلاح جودة P2",
  agency: "جهة اختبار",
  fee: 0,
  region: "منطقة الرياض",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=p2-quality",
  score: 70,
  remoteAttachments: [],
};

test("P2 quality: visible ZIP/RAR/7Z names are captured alongside PDF and Office", () => {
  const names = selectVisibleAttachmentNames(attachmentFixture.candidates);
  assert.deepEqual(names, attachmentFixture.expectedNames);
  assert.ok(names.includes("المخططات.zip"));
  assert.ok(names.includes("مرفقات المنصة.zip"));
  assert.ok(names.includes("boq final.zip"));
  for (const blocked of ["تحميل الملف", "ملفات داعمة", "المرفق", "شراء الكراسة", "انضمام للمنافسة"]) {
    assert.equal(isVisibleAttachmentName(blocked), false, `action label must stay excluded: ${blocked}`);
  }
  assert.equal(isVisibleAttachmentName("صورة توضيحية.png"), false);
});

test("P2 quality: compressed names persist through the detail record into SQLite as metadata only", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p2-quality-"));
  let repository;
  try {
    repository = await createRadarRepository({ projectRoot });
    const runId = repository.startSyncRun();
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T18:00:00.000Z", checked: 1, regions: 13, targetPerRegion: 100,
      added: [tender], changed: [], items: [tender],
    }, runId);
    const names = selectVisibleAttachmentNames(attachmentFixture.candidates);
    const record = buildDetailRecord({
      reference: tender.reference,
      sourceUrl: tender.etimadUrl,
      pageTitle: "تفاصيل المنافسة",
      inspectedAt: "2026-08-13T18:05:00.000Z",
      sections: [{ name: "المرفق", text: names.join("\n") }],
      attachmentNames: names,
    });
    assert.equal(record.status, "complete", "no visible tabs means no completeness penalty");
    repository.saveTenderDetails(record);
    const stored = repository.getTender(tender.reference);
    assert.ok(stored.remoteAttachments.includes("المخططات.zip"));
    assert.ok(stored.remoteAttachments.includes("مرفقات المنصة.zip"));
    assert.ok(stored.remoteAttachments.includes("الشروط الخاصة.rar"));
    assert.ok(stored.remoteAttachments.includes("الملحقات الداعمة.7z"));
    assert.equal(stored.details.downloaded ?? false, false);
    const meta = repository.listAttachmentMeta(tender.reference);
    assert.equal(meta.length, names.length);
    assert.ok(meta.every((item) => item.availability === "metadata-only"));
    assert.ok(meta.every((item) => item.requiresApproval === true));
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P2 quality: an incomplete read with visible tabs is partial with a clear reason, never complete", () => {
  const visibleTabCount = tabsFixture.visibleTabs.length;
  const firstPassCount = tabsFixture.firstPassSections.length;
  const assessment = assessDetailCompleteness({ visibleTabCount, sectionsRead: firstPassCount });
  assert.equal(assessment.expected, visibleTabCount);
  assert.equal(assessment.complete, false);
  assert.match(assessment.reason, /قراءة ناقصة/);
  assert.match(assessment.reason, /2 من 5/);
  assert.equal(shouldRetryDetailRead({ visibleTabCount, sectionsRead: firstPassCount }), true);

  const partialRecord = buildDetailRecord({
    reference: tender.reference,
    sourceUrl: tender.etimadUrl,
    pageTitle: "تفاصيل المنافسة",
    inspectedAt: "2026-08-13T18:10:00.000Z",
    sections: tabsFixture.firstPassSections,
    attachmentNames: [],
    visibleTabCount,
  });
  assert.equal(partialRecord.status, "partial");
  assert.match(partialRecord.errorMessage, /قراءة ناقصة/);

  const mergedSections = [...tabsFixture.firstPassSections, ...tabsFixture.retrySections];
  const retried = assessDetailCompleteness({ visibleTabCount, sectionsRead: mergedSections.length });
  assert.equal(retried.complete, true, "after one bounded retry the full tab set is complete");
  const completeRecord = buildDetailRecord({
    reference: tender.reference,
    sourceUrl: tender.etimadUrl,
    pageTitle: "تفاصيل المنافسة",
    inspectedAt: "2026-08-13T18:11:00.000Z",
    sections: mergedSections,
    attachmentNames: ["المخططات.zip"],
    visibleTabCount,
  });
  assert.equal(completeRecord.status, "complete");
  assert.equal(completeRecord.errorMessage, undefined);
});

test("P2 quality: the retry is bounded to one attempt and never fires without visible tabs", () => {
  assert.equal(shouldRetryDetailRead({ visibleTabCount: 5, sectionsRead: 2, alreadyRetried: false }), true);
  assert.equal(shouldRetryDetailRead({ visibleTabCount: 5, sectionsRead: 2, alreadyRetried: true }), false);
  assert.equal(shouldRetryDetailRead({ visibleTabCount: 0, sectionsRead: 1 }), false);
  assert.equal(assessDetailCompleteness({ visibleTabCount: 0, sectionsRead: 1 }).complete, true);
});

test("P2 quality: the live capture path filters names in Node and applies the completeness rule", async () => {
  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  assert.match(service, /selectVisibleAttachmentNames/);
  assert.match(service, /shouldRetryDetailRead/);
  assert.match(service, /visibleTabCount: tabs\.length/);
  assert.doesNotMatch(service, /\.download\(|شراء كراسة|submitOffer|joinTender/i);
});
