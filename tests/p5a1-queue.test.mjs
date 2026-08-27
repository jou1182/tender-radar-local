// اختبارات P5-A1 v2 (P5-B0PRE) — حياد الرسوم في مقيّم الطابور
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { evaluateQueueForRun, setDownloadPolicy } from "../scripts/lib/attachment-queue-evaluator.mjs";

const feeVariants = [
  { fee: 0, feeVerification: "detail-verified" },
  { fee: 200, feeVerification: "detail-verified" },
  { fee: 600, feeVerification: "card-observed" },
  { fee: null, feeVerification: "unknown" },
];

async function makeRepo(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = await createRadarRepository({ projectRoot });
  // بذر المنافسة في tenders (قيد المفتاح الأجنبي للطابور)
  repo.saveCompletedSync({
    lastSyncAt: new Date().toISOString(),
    items: [{ reference: "260739009419", title: "منافسة بذر", agency: "جهة", fee: 0, region: "القصيم" }],
    added: [], changed: [], scope: {},
  }, "run-seed");
  return { projectRoot, repo };
}

test("P5-A1-v2-1: every fee variant lands as proposed identically (fee-neutral)", async () => {
  for (const variant of feeVariants) {
    const { projectRoot, repo } = await makeRepo("radar-p5a1-");
    try {
      const summary = evaluateQueueForRun(repo, [{
        reference: "260739009419",
        fee: variant.fee,
        feeVerification: variant.feeVerification,
        remoteAttachments: ["كراسة.pdf", "كميات.xlsx"],
      }]);
      assert.equal(summary.proposed, 2, JSON.stringify(variant));
      assert.equal(summary.autoApproved, 0);
      assert.equal(repo.listDownloadQueue("proposed").length, 2);
    } finally {
      repo.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

test("P5-A1-v2-2: standing policy auto-approves regardless of fees", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-open-");
  try {
    setDownloadPolicy(repo, { autoApproveVerifiedFree: true });
    const summary = evaluateQueueForRun(repo, [
      { reference: "260739009419", fee: 600, feeVerification: "card-observed", remoteAttachments: ["كراسة.pdf"] },
    ]);
    assert.equal(summary.autoApproved, 1);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A1-v2-3: per-tender file cap still enforced", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-cap-");
  try {
    const many = Array.from({ length: 9 }, (_, i) => `ملف-${i}.pdf`);
    const summary = evaluateQueueForRun(repo, [{
      reference: "260739009419",
      remoteAttachments: many,
    }], { policy: { maxFilesPerTender: 5 } });
    assert.ok(summary.rowsCreated <= 5);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
