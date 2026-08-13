import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDetailRecord, classifyAttachmentName, parseDetailFields } from "../scripts/lib/etimad-detail-parser.mjs";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

const tender = {
  id: "260000000090",
  reference: "260000000090",
  title: "صيانة مبنى حكومي",
  agency: "جهة اختبار",
  fee: 200,
  region: "منطقة القصيم",
  deadline: "2026-09-01 09:59",
  publishedAt: "2026-08-13",
  platformStatus: "المنافسات النشطة (تقديم العروض)",
  activity: "المقاولات",
  etimadUrl: "https://tenders.etimad.sa/Tender/Details?STenderId=test",
  score: 70,
  remoteAttachments: [],
};

test("P2 parses visible Arabic fields and classifies attachment names", () => {
  const sections = [{
    name: "المعلومات الأساسية",
    text: "رقم المنافسة\nT-90\nالنشاط الفرعي: مقاولات عامة للمباني\nمدة العقد\n12 شهر\nالضمان الابتدائي: 1%",
  }];
  const fields = parseDetailFields(sections);
  assert.equal(fields.tenderNumber, "T-90");
  assert.equal(fields.subActivity, "مقاولات عامة للمباني");
  assert.equal(fields.contractDuration, "12 شهر");
  assert.equal(fields.guarantee, "1%");
  assert.equal(classifyAttachmentName("جدول الكميات.xlsx"), "boq");
  assert.equal(classifyAttachmentName("كراسة الشروط والمواصفات.pdf"), "booklet");
  assert.equal(classifyAttachmentName("ملف الغرامات.pdf"), "penalties");
});

test("P2 stores one current detail snapshot and only new historical content", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p2-"));
  let repository;
  try {
    repository = await createRadarRepository({ projectRoot });
    const runId = repository.startSyncRun();
    repository.saveCompletedSync({
      lastSyncAt: "2026-08-13T12:00:00.000Z", checked: 1, regions: 13, targetPerRegion: 100,
      added: [tender], changed: [], items: [tender],
    }, runId);
    const record = buildDetailRecord({
      reference: tender.reference,
      sourceUrl: tender.etimadUrl,
      pageTitle: "تفاصيل المنافسة",
      inspectedAt: "2026-08-13T12:10:00.000Z",
      sections: [{ name: "المعلومات الأساسية", text: "رقم المنافسة: T-90\nمدة العقد: 12 شهر\nالوقت المتبقى\n10 دقائق" }],
      attachmentNames: ["كراسة الشروط.pdf", "جدول الكميات.xlsx"],
    });
    repository.saveTenderDetails(record);
    repository.saveTenderDetails({
      ...record,
      inspectedAt: "2026-08-13T12:20:00.000Z",
      fields: { ...record.fields, timeRemaining: "9 دقائق" },
      sections: record.sections.map((section) => ({ ...section, text: section.text.replace("10 دقائق", "9 دقائق") })),
    });
    const stored = repository.getTender(tender.reference);
    assert.equal(stored.tenderNumber, "T-90");
    assert.equal(stored.details.status, "complete");
    assert.equal(stored.details.sections.length, 1);
    assert.deepEqual(stored.remoteAttachments, ["كراسة الشروط.pdf", "جدول الكميات.xlsx"]);
    assert.equal(repository.getDetailHistoryCount(tender.reference), 1);
    assert.deepEqual(repository.getDetailsStats(), { inspected: 1, complete: 1, failed: 0 });
  } finally {
    repository?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P2 exposes a bounded details sample and contains no purchase or download action", async () => {
  const [service, page] = await Promise.all([
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(service, /request\.url === "\/details\/batch"/);
  assert.match(service, /references\.length > 3/);
  assert.match(service, /downloaded: false/);
  assert.match(service, /purchased: false/);
  assert.doesNotMatch(service, /\.download\(|شراء كراسة|submitOffer|joinTender/i);
  assert.match(page, /اختبار تفاصيل عينة \(2\)/);
  assert.match(page, /Rصد P2|رصد P2/);
});
