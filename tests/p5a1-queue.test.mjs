// اختبارات P5-A1 — مقيّم طابور التحميل وفق السياسة
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { evaluateQueueForRun, setDownloadPolicy } from "../scripts/lib/attachment-queue-evaluator.mjs";

async function makeRepo(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = await createRadarRepository({ projectRoot });
  repo.saveCompletedSync({
    lastSyncAt: new Date().toISOString(),
    items: [
      { reference: "260739009419", title: "مجانية مؤكدة", agency: "أمانة", fee: 0, region: "القصيم", feeVerification: "detail-verified", remoteAttachments: ["كراسة.pdf", "كميات.xlsx"] },
      { reference: "260839002206", title: "مدفوعة", agency: "بلدية", fee: 200, region: "القصيم", feeVerification: "detail-verified", remoteAttachments: ["كراسة.pdf"] },
      { reference: "260839001913", title: "رسوم غير مؤكدة", agency: "جهة", fee: null, remoteAttachments: ["ملف.zip"] },
    ],
    added: [], changed: [], scope: {},
  }, "run-seed");
  return { projectRoot, repo };
}

test("P5-A1-1: default policy is closed — verified-free lands as proposed awaiting manual approval", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-closed-");
  try {
    const summary = evaluateQueueForRun(repo, [
      { reference: "260739009419", fee: 0, feeVerification: "detail-verified", remoteAttachments: ["كراسة.pdf", "كميات.xlsx"] },
    ]);
    assert.equal(summary.proposed, 2);
    assert.equal(summary.autoApproved, 0);
    assert.equal(repo.listDownloadQueue("proposed").length, 2);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A1-2: open policy promotes verified-free to auto-approved", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-open-");
  try {
    setDownloadPolicy(repo, { autoApproveVerifiedFree: true });
    const summary = evaluateQueueForRun(repo, [
      { reference: "260739009419", fee: 0, feeVerification: "detail-verified", remoteAttachments: ["كراسة.pdf", "كميات.xlsx"] },
    ]);
    assert.equal(summary.autoApproved, 2);
    assert.equal(repo.listDownloadQueue("auto-approved").length, 2);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A1-3: paid tenders always wait for the owner's manual purchase", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-paid-");
  try {
    const summary = evaluateQueueForRun(repo, [
      { reference: "260839002206", fee: 200, feeVerification: "detail-verified", remoteAttachments: ["كراسة.pdf"] },
    ]);
    assert.equal(summary.waitingPurchase, 1);
    assert.equal(summary.autoApproved + summary.proposed, 0);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A1-4: unverified fees are blocked with no guessing", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-blocked-");
  try {
    const summary = evaluateQueueForRun(repo, [
      { reference: "260839001913", fee: null, remoteAttachments: ["ملف.zip"] },
    ]);
    assert.equal(summary.blocked, 1);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-A1-5: per-tender file cap from the gate (max 5) is enforced", async () => {
  const { projectRoot, repo } = await makeRepo("radar-p5a1-cap-");
  try {
    const many = Array.from({ length: 9 }, (_, i) => `ملف-${i}.pdf`);
    const summary = evaluateQueueForRun(repo, [
      { reference: "260739009419", fee: 0, feeVerification: "detail-verified", remoteAttachments: many },
    ], { policy: { autoApproveVerifiedFree: true, maxFilesPerTender: 5 } });
    assert.ok(summary.rowsCreated <= 5, `rows ${summary.rowsCreated}`);
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
