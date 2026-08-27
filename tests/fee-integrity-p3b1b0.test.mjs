import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import {
  assertDownloadFeeGate,
  cardFeeEvidence,
  detailFeeEvidence,
  isTrustedEtimadDetailsUrl,
  mergeSyncFeeEvidence,
  parseFeeEvidence,
} from "../scripts/lib/fee-evidence.mjs";
import { assertLivePreconditions } from "../scripts/lib/live-attachment-acquisition.mjs";
import { mergeTenderAppearances } from "../scripts/lib/sync-plan.mjs";

const trustedUrl = (reference) => `https://tenders.etimad.sa/Tender/DetailsForSupplier?STenderId=${reference}`;

function item(reference, feeText = "") {
  return {
    id: reference,
    reference,
    title: "منافسة اختبار النزاهة",
    agency: "جهة اختبار",
    feeRawText: feeText || null,
    ...cardFeeEvidence(feeText),
    region: "منطقة الرياض",
    deadline: "2026-09-01 09:59",
    publishedAt: "2026-08-14",
    platformStatus: "المنافسات النشطة (تقديم العروض)",
    activity: "المقاولات",
    etimadUrl: trustedUrl(reference),
    score: 60,
    remoteAttachments: [],
  };
}

async function withRepository(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-fee-integrity-"));
  const repository = await createRadarRepository({ projectRoot });
  try {
    await callback(repository);
  } finally {
    repository.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function save(repository, items, at = "2026-08-14T01:00:00.000Z") {
  const runId = repository.startSyncRun();
  repository.saveCompletedSync({
    lastSyncAt: at,
    checked: items.length,
    regions: 13,
    targetPerRegion: 100,
    added: items,
    changed: [],
    items,
  }, runId);
}

test("fee parser handles Western and Arabic zero/positive values and rejects ambiguous input", () => {
  for (const raw of ["0", "0.00 ر.س", "٠", "٠٫٠٠ ريال"]) assert.equal(parseFeeEvidence(raw)?.value, 0);
  for (const raw of ["1,000.00 ر.س", "١٬٠٠٠٫٠٠ ريال"]) assert.equal(parseFeeEvidence(raw)?.value, 1000);
  assert.equal(parseFeeEvidence("غير متوفر"), null);
  assert.equal(parseFeeEvidence("200 أو 300"), null);
  assert.equal(parseFeeEvidence("-100"), null);
});

test("only exact trusted Etimad details paths can certify evidence", () => {
  assert.equal(isTrustedEtimadDetailsUrl(trustedUrl("260000001001")), true);
  assert.equal(isTrustedEtimadDetailsUrl("https://tenders.etimad.sa/Tender/Details?id=1"), true);
  assert.equal(isTrustedEtimadDetailsUrl("https://tenders.etimad.sa/Tender/DetailsEvil?id=1"), false);
  assert.equal(isTrustedEtimadDetailsUrl("http://tenders.etimad.sa/Tender/Details?id=1"), false);
  assert.equal(isTrustedEtimadDetailsUrl("https://evil.example/Tender/Details?id=1"), false);
  assert.equal(detailFeeEvidence({ rawText: "0", sourceUrl: "https://evil.example/Tender/Details", verifiedAt: new Date() }), null);
});

test("the free filter bucket never overrides the visible card fee", async () => {
  await withRepository(async (repository) => {
    const paid = item("260000001002", "قيمة وثائق المنافسة: 1,000 ريال");
    save(repository, [paid]);
    const stored = repository.getTender(paid.reference);
    assert.equal(stored.fee, 1000);
    assert.equal(stored.feeVerification, "card-observed");
    assert.equal(stored.feeRawText, "قيمة وثائق المنافسة: 1,000 ريال");
  });
});

test("P5-B0PRE: missing card fee stays unknown (informational) and no longer blocks downloads", async () => {
  await withRepository(async (repository) => {
    const unknown = item("260000001003");
    save(repository, [unknown]);
    const stored = repository.getTender(unknown.reference);
    assert.equal(stored.fee, 0);
    assert.equal(stored.feeVerification, "unknown");
    assert.equal(assertDownloadFeeGate(stored), true, "P5-B0PRE: fee gate deprecated — never blocks");
  });
});

test("only a successful/partial trusted details read can certify zero", async () => {
  await withRepository(async (repository) => {
    const unknown = item("260000001004");
    save(repository, [unknown]);
    repository.saveTenderDetails({
      reference: unknown.reference,
      status: "failed",
      inspectedAt: "2026-08-14T01:05:00.000Z",
      sourceUrl: trustedUrl(unknown.reference),
      pageTitle: "",
      fields: { bookletFee: "0" },
      sections: [],
      attachments: [],
    });
    assert.equal(repository.getTender(unknown.reference).feeVerification, "unknown");

    repository.saveTenderDetails({
      reference: unknown.reference,
      status: "complete",
      inspectedAt: "2026-08-14T01:06:00.000Z",
      sourceUrl: trustedUrl(unknown.reference),
      pageTitle: "",
      fields: { bookletFee: "٠٫٠٠" },
      sections: [],
      attachments: [],
    });
    const verified = repository.getTender(unknown.reference);
    assert.equal(verified.fee, 0);
    assert.equal(verified.feeVerification, "detail-verified");
    assert.equal(verified.feeVerifiedAt, "2026-08-14T01:06:00.000Z");
    assert.equal(assertDownloadFeeGate(verified), true);
  });
});

test("verified paid details correct false zero and revoke false free availability", async () => {
  await withRepository(async (repository) => {
    const unknown = item("260000001005");
    unknown.remoteAttachments = ["كراسة الشروط.pdf", "جدول الكميات.xlsx"];
    save(repository, [unknown]);
    repository.setAttachmentAvailability(unknown.reference, "كراسة الشروط.pdf", "free-available");
    repository.setAttachmentAvailability(unknown.reference, "جدول الكميات.xlsx", "purchased-available");
    repository.saveTenderDetails({
      reference: unknown.reference,
      status: "complete",
      inspectedAt: "2026-08-14T01:07:00.000Z",
      sourceUrl: trustedUrl(unknown.reference),
      pageTitle: "",
      fields: { bookletFee: "٨٠٠" },
      sections: [],
      attachments: unknown.remoteAttachments.map((displayName) => ({ displayName })),
    });
    const stored = repository.getTender(unknown.reference);
    assert.equal(stored.fee, 800);
    assert.equal(stored.feeVerification, "detail-verified");
    const availability = Object.fromEntries(stored.attachmentsMeta.map((entry) => [entry.displayName, entry.availability]));
    assert.equal(availability["كراسة الشروط.pdf"], "restricted");
    assert.equal(availability["جدول الكميات.xlsx"], "purchased-available");
  });
});

test("live preflight rejects unverified zero before any acquisition", () => {
  const tender = {
    fee: 0,
    feeVerification: "unknown",
    feeVerifiedAt: null,
    details: { sourceUrl: trustedUrl("260000001006") },
    attachmentsMeta: [{ displayName: "كراسة.pdf", remoteVisible: true, availability: "free-available" }],
  };
  assert.throws(
    () => assertLivePreconditions({ tender, displayName: "كراسة.pdf" }),
    (error) => error.code === "FEE_NOT_DETAIL_VERIFIED",
  );
});

test("appearance merging keeps the strongest visible fee evidence", () => {
  const merged = mergeTenderAppearances([
    { ...item("260000001007"), regionName: "منطقة الرياض" },
    { ...item("260000001007", "200"), regionName: "منطقة القصيم" },
  ]);
  assert.equal(merged[0].fee, 200);
  assert.equal(merged[0].feeVerification, "card-observed");
  assert.deepEqual(merged[0].regions, ["منطقة الرياض", "منطقة القصيم"]);
});

test("sync evidence merging never demotes a detail-verified fee", () => {
  const previous = { fee: 0, feeVerification: "detail-verified", feeRawText: "0" };
  assert.deepEqual(mergeSyncFeeEvidence(previous, cardFeeEvidence("200")), previous);
  assert.deepEqual(
    mergeSyncFeeEvidence({ fee: 500, feeVerification: "card-observed", feeRawText: "500" }, cardFeeEvidence("")),
    { fee: 500, feeVerification: "card-observed", feeRawText: "500" },
  );
});

test("service and UI never label bare zero as free", async () => {
  const [service, ui] = await Promise.all([
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(service, /feeBucket\s*===\s*["']free["']\s*\?\s*0/);
  assert.match(service, /mergeSyncFeeEvidence/);
  assert.match(ui, /مجانية مؤكدة/);
  assert.match(ui, /السعر غير متحقق/);
  assert.match(ui, /feeVerification === "card-observed"/);
});
