// P5-B0PRE — اختبار حياد الرسوم: قيمة الكراسة معلوماتية لا شرط تنزيل.
// يثبت أن منافسة صفرية/مدفوعة/غير معروفة الرسوم تمر بمسار التنزيل نفسه
// بالنفس الملفات، وأن الحارس الوحيد هو عبارة الموافقة الصريحة.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { verifyDownloadConsent, downloadConsentPhrase, validateDownloadRequest } from "../scripts/lib/download-gate.mjs";
import { assertDownloadFeeGate } from "../scripts/lib/fee-evidence.mjs";
import { evaluateQueueForRun } from "../scripts/lib/attachment-queue-evaluator.mjs";

const feeVariants = [
  { label: "مجانية مؤكدة", fee: 0, feeVerification: "detail-verified" },
  { label: "مدفوعة 200 ريال", fee: 200, feeVerification: "detail-verified" },
  { label: "مدفوعة 600 ريال", fee: 600, feeVerification: "card-observed" },
  { label: "رسوم غير معروفة", fee: null, feeVerification: "unknown" },
];

async function makeRepoWithTender(feeVariant) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-b0pre-"));
  const repo = await createRadarRepository({ projectRoot });
  repo.saveCompletedSync({
    lastSyncAt: new Date().toISOString(),
    items: [{
      reference: "260739009419",
      title: `منافسة ${feeVariant.label}`,
      agency: "جهة اختبار",
      fee: feeVariant.fee,
      feeVerification: feeVariant.feeVerification,
      remoteAttachments: ["كراسة.pdf", "كميات.xlsx"],
    }],
    added: [], changed: [], scope: {},
  }, "run-1");
  return { projectRoot, repo };
}

test("P5-B0PRE-1: approval intent + confirm succeed for EVERY fee variant via the identical path", async () => {
  for (const variant of feeVariants) {
    const { projectRoot, repo } = await makeRepoWithTender(variant);
    try {
      const intent = repo.requestDownloadApprovalIntent({
        tenderReference: "260739009419",
        files: [{ displayName: "كراسة.pdf", size: 1024 }],
      });
      assert.ok(intent.id, `${variant.label}: intent created`);

      const approval = repo.confirmDownloadApprovalIntent(intent.id, {
        consentText: downloadConsentPhrase,
        // ملاحظة: purchaseConfirmed مقصود عدم تمريره حتى في المدفوعة — لا شرط شراء بعد التصحيح
      });
      assert.equal(approval.status, "approved", `${variant.label}: approved identically`);
      assert.equal(assertDownloadFeeGate(repo.getTender("260739009419")), true);
    } finally {
      repo.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("P5-B0PRE-2: consent phrase remains the ONLY gate — missing phrase fails for every variant", () => {
  for (const variant of feeVariants) {
    assert.throws(
      () => verifyDownloadConsent({ consentText: "موافقة جزئية", purchaseConfirmed: variant.fee === 0 }),
      (error) => error.code === "CONSENT_REQUIRED",
      variant.label,
    );
  }
  // ولا حتى تأكيد شراء يدوي ينفرد بفتح البوابة بدون العبارة:
  assert.throws(
    () => verifyDownloadConsent({ consentText: "نص خاطئ", purchaseConfirmed: true, bookletFee: 200 }),
    (error) => error.code === "CONSENT_REQUIRED",
  );
});

test("P5-B0PRE-3: purchase confirmation is no longer required for paid tenders", () => {
  // المدفوعة تمامًا كالمجانية: العبارة تكفي
  assert.equal(
    verifyDownloadConsent({ consentText: downloadConsentPhrase, bookletFee: 600 }),
    true,
  );
  assert.equal(
    verifyDownloadConsent({ consentText: downloadConsentPhrase, bookletFee: 0, purchaseConfirmed: false }),
    true,
  );
});

test("P5-B0PRE-4: queue evaluator treats every fee variant identically (all proposed)", async () => {
  for (const variant of feeVariants) {
    const { projectRoot, repo } = await makeRepoWithTender(variant);
    try {
      const summary = evaluateQueueForRun(repo, [{
        reference: "260739009419",
        fee: variant.fee,
        feeVerification: variant.feeVerification,
        remoteAttachments: ["كراسة.pdf", "كميات.xlsx"],
      }]);
      assert.equal(summary.rowsCreated, 2, variant.label);
      assert.equal(summary.proposed, 2, variant.label);
      assert.equal(summary.autoApproved, 0, variant.label);
      const states = new Set(repo.listDownloadQueue().map((row) => row.state));
      assert.deepEqual([...states], ["proposed"], variant.label);
    } finally {
      repo.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("P5-B0PRE-5: availability states are informational — metadata-only files are now requestable", () => {
  const manifest = validateDownloadRequest({
    tenderReference: "260739009419",
    files: [{ displayName: "مرفق-ظاهر.pdf", size: 500 }],
    attachmentsMeta: [{ displayName: "مرفق-ظاهر.pdf", availability: "metadata-only", requiresApproval: true }],
  });
  assert.equal(manifest.files.length, 1);
});

test("P5-B0PRE-6: security gates unrelated to fees still hold (limits, extensions, listed files)", () => {
  const base = {
    tenderReference: "260739009419",
    attachmentsMeta: [
      { displayName: "كراسة.pdf", availability: "metadata-only" },
      { displayName: "كبير.pdf", availability: "metadata-only", size: 101 * 1024 * 1024 },
    ],
  };
  assert.throws(
    () => validateDownloadRequest({ ...base, files: [{ displayName: "فيروس.exe" }] }),
    (e) => e.code === "EXTENSION_NOT_ALLOWED",
  );
  assert.throws(
    () => validateDownloadRequest({ ...base, files: [{ displayName: "غير-مرصود.pdf" }] }),
    (e) => e.code === "FILE_NOT_LISTED",
  );
  assert.throws(
    () => validateDownloadRequest({ ...base, files: [{ displayName: "كبير.pdf", size: 101 * 1024 * 1024 }] }),
    (e) => e.code === "FILE_TOO_LARGE",
  );
});
