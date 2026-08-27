// مقيّم طابور التحميل — P5-B0PRE (وكيل «عبدالله») — v2
// قرار د. جو 2026-08-25: كل ملفات أي منافسة على اعتماد قابلة للتنزيل دائمًا؛
// قيمة الكراسة معلوماتية تخص تقديم العروض (خارج نطاق المنصة) ولا تؤثر هنا.
// المعادلة الموحدة: كل ملف ظاهر في أي منافسة ⇒ صف proposed واحد —
// والموافقة الصريحة اليدوية للمالك (عبارة النص الكامل) هي الحارس الوحيد.
// auto-approved تبقى معطلة افتراضيًا (سياسة دائمة مستقبلية بقرار صريح).
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

// DEPRECATED v1 logic (fee-based states waiting-purchase / blocked FEE_UNVERIFIED)
// أُزيل بالكامل — لا يُعاد إدخال قيمة الكراسة في قرار التنزيل دون مهمة معتمدة.
export function evaluateQueueForRun(repository, items, { policy: overrides } = {}) {
  const policy = getEffectivePolicy(repository, overrides);
  const summary = { rowsCreated: 0, proposed: 0, autoApproved: 0 };

  for (const item of items ?? []) {
    const attachments = Array.isArray(item?.remoteAttachments)
      ? item.remoteAttachments.slice(0, policy.maxFilesPerTender)
      : [];
    if (!attachments.length) continue;

    const state = policy.autoApproveVerifiedFree ? "auto-approved" : "proposed";
    for (const fileName of attachments) {
      repository.enqueueDownload({
        tenderReference: item.reference,
        fileName,
        state,
      });
      summary.rowsCreated += 1;
      if (state === "auto-approved") summary.autoApproved += 1;
      else summary.proposed += 1;
    }
  }
  return summary;
}
