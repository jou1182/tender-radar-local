// مقيّم طابور التحميل — P5-A1 (وكيل «عبدالله»)
// بعد كل جولة مزامنة: لكل منافسة جديدة تُنشأ صفوف طابور من أسماء المرفقات الظاهرة.
// القواعد الحاكمة (SAFETY_BOUNDARIES + قرار المالك 2026-08-25):
// - المجاني المؤكد (detail-verified + fee=0): proposed افتراضيًا، وauto-approved فقط
//   إذا فتح المالك السياسة الدائمة.
// - المدفوع: waiting-purchase دائمًا — لا شراء آلي إطلاقًا.
// - الرسوم غير المؤكدة: blocked بلا تخمين («غير معروف» لا يُخترع).
// - حد الملفات لكل منافسة يأتي من بوابة التنزيل نفسها (maxFilesPerBatch=5).
import { maxFilesPerBatch } from "./download-gate.mjs";

export const downloadPolicyKey = "downloadPolicy";

export function getEffectivePolicy(store, overrides = {}) {
  const stored = store.getPolicySetting(downloadPolicyKey) ?? {};
  return {
    autoApproveVerifiedFree: false,
    maxFilesPerTender: maxFilesPerBatch,
    dailyDetailReadsCap: 30,
    ...stored,
    ...overrides,
  };
}

export function setDownloadPolicy(store, policy) {
  return store.setPolicySetting(downloadPolicyKey, {
    autoApproveVerifiedFree: false,
    maxFilesPerTender: maxFilesPerBatch,
    dailyDetailReadsCap: 30,
    ...policy,
  });
}

function isVerifiedFree(item) {
  return item?.feeVerification === "detail-verified" && Number(item?.fee ?? -1) === 0;
}

export function evaluateQueueForRun(repository, items, { policy: overrides } = {}) {
  const policy = getEffectivePolicy(repository, overrides);
  const summary = { rowsCreated: 0, proposed: 0, autoApproved: 0, waitingPurchase: 0, blocked: 0 };

  for (const item of items ?? []) {
    const attachments = Array.isArray(item?.remoteAttachments) ? item.remoteAttachments.slice(0, policy.maxFilesPerTender) : [];
    if (!attachments.length) continue;

    let state;
    if (isVerifiedFree(item)) {
      state = policy.autoApproveVerifiedFree ? "auto-approved" : "proposed";
    } else if (item?.feeVerification === "detail-verified" && Number(item.fee) > 0) {
      state = "waiting-purchase";
    } else {
      state = "blocked";
    }

    for (const fileName of attachments) {
      repository.enqueueDownload({
        tenderReference: item.reference,
        fileName,
        state: state === "blocked" ? "proposed" : state,
        // المحجوبة تُسجل كـ blocked صريحًا مع سبب في error_code
      });
      if (state === "blocked") {
        // نحدّث آخر صف لنفس المنافسة/الملف إلى blocked مع السبب
        const rows = repository.listDownloadQueue("proposed");
        const match = rows.find((row) => row.tender_reference === String(item.reference) && row.file_name === fileName);
        if (match) repository.updateDownloadQueueState(match.id, { state: "blocked", errorCode: "FEE_UNVERIFIED" });
      }
      summary.rowsCreated += 1;
      if (state === "auto-approved") summary.autoApproved += 1;
      else if (state === "waiting-purchase") summary.waitingPurchase += 1;
      else if (state === "blocked") summary.blocked += 1;
      else summary.proposed += 1;
    }
  }
  return summary;
}
