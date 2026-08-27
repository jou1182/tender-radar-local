// بوابة الموافقة البشرية لتنزيل المرفقات — منطق نقي قابل للاختبار دون متصفح أو شبكة.
// لا يوجد هنا أي تنزيل فعلي؛ هذه الوحدة تصنع manifest وتتحقق من حدوده وتقيّم صلاحية الموافقة فقط.
import { createHash } from "node:crypto";

export const downloadApprovalAction = "download-attachments";
export const approvalTtlMs = 10 * 60_000;
export const approvalIntentTtlMs = 10 * 60_000;
export const maxFilesPerBatch = 5;
export const maxFileBytes = 100 * 1024 * 1024;
export const maxBatchBytes = 300 * 1024 * 1024;
export const allowedDownloadExtensions = ["pdf", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "zip", "rar", "7z"];
export const downloadableAvailability = ["metadata-only", "free-available", "purchased-available", "restricted", "unknown"];
// P5-B0PRE: حالات الإتاحة صارت معلوماتية — كل ملف ظاهر الاسم قابل للطلب،
// والموافقة الصريحة (عبارة النص الكامل) هي الحارس الوحيد.
export const downloadConsentPhrase = "أوافق على تنزيل الملفات المحددة الآن من هذه المنافسة فقط";
export const purchaseConsentPhrase = "أؤكد أنني أتممت شراء الكراسة بنفسي داخل منصة اعتماد";

export function downloadGateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function fileExtension(displayName) {
  const name = String(displayName || "").trim();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function buildDownloadManifest({ tenderReference, files } = {}) {
  const seen = new Map();
  for (const file of files || []) {
    const displayName = String(typeof file === "string" ? file : file?.displayName || "").trim();
    if (!displayName) continue;
    const rawSize = typeof file === "object" ? file?.size : null;
    const size = rawSize === null || rawSize === undefined || rawSize === "" ? null : Math.max(0, Math.floor(Number(rawSize)));
    if (!seen.has(displayName)) seen.set(displayName, { displayName, size: Number.isFinite(size) ? size : null });
  }
  const normalized = [...seen.values()].sort((left, right) => left.displayName.localeCompare(right.displayName, "ar"));
  return { tenderReference: String(tenderReference || "").trim(), files: normalized };
}

export function hashDownloadManifest(manifest) {
  const stable = JSON.stringify({
    tenderReference: manifest?.tenderReference || "",
    files: (manifest?.files || []).map((file) => [file.displayName, file.size]),
  });
  return createHash("sha256").update(stable).digest("hex");
}

// يتحقق من طلب تنزيل واحد: منافسة واحدة، قائمة ملفات محددة، حدود الدفعة، الصيغ، وحالات الإتاحة.
export function validateDownloadRequest({ tenderReference, files, attachmentsMeta } = {}) {
  const reference = String(tenderReference || "").trim();
  if (!reference) throw downloadGateError("INVALID_DOWNLOAD_REQUEST", "طلب التنزيل يجب أن يستهدف منافسة واحدة محددة.");
  const manifest = buildDownloadManifest({ tenderReference: reference, files });
  if (!manifest.files.length) throw downloadGateError("INVALID_DOWNLOAD_REQUEST", "حدد ملفًا واحدًا على الأقل من أسماء المرفقات الظاهرة.");
  if (manifest.files.length > maxFilesPerBatch) {
    throw downloadGateError("BATCH_LIMIT_EXCEEDED", `الحد الأقصى للدفعة ${maxFilesPerBatch} ملفات؛ طُلب ${manifest.files.length}.`);
  }
  const metaByName = new Map((attachmentsMeta || []).map((meta) => [meta.displayName, meta]));
  let batchBytes = 0;
  let allSizesKnown = true;
  for (const file of manifest.files) {
    const extension = fileExtension(file.displayName);
    if (!allowedDownloadExtensions.includes(extension)) {
      throw downloadGateError("EXTENSION_NOT_ALLOWED", `الصيغة غير مسموحة في P3-B0: ${file.displayName}`);
    }
    const meta = metaByName.get(file.displayName);
    if (!meta) throw downloadGateError("FILE_NOT_LISTED", `الملف ليس ضمن المرفقات المرصودة للمنافسة: ${file.displayName}`);
    if (!downloadableAvailability.includes(meta.availability)) {
      throw downloadGateError("AVAILABILITY_NOT_ALLOWED", `لا يمكن طلب تنزيل ملف بحالة ${meta.availability}: ${file.displayName}`);
    }
    if (file.size !== null) {
      if (file.size > maxFileBytes) {
        throw downloadGateError("FILE_TOO_LARGE", `حجم الملف يتجاوز 100MB: ${file.displayName}`);
      }
      batchBytes += file.size;
    } else {
      allSizesKnown = false;
    }
  }
  if (allSizesKnown && batchBytes > maxBatchBytes) {
    throw downloadGateError("BATCH_TOO_LARGE", "حجم الدفعة يتجاوز 300MB.");
  }
  return manifest;
}

// الموافقة بشرية صريحة فقط: النص الكامل مطابق حرفيًا. — v2 (P5-B0PRE)
// قرار د. جو: قيمة الكراسة معلوماتية لا شرط تنزيل؛ شراء الكراسة داخل اعتماد
// يخص تقديم العروض وهو خارج نطاق هذه المنصة كليًا. الحارس الوحيد: عبارة الموافقة.
// purchaseConfirmed وbookletFee يقبلان للتوافق الخلفي ويُتجاهلان.
export function verifyDownloadConsent({ consentText, purchaseConfirmed, bookletFee } = {}) {
  void purchaseConfirmed;
  void bookletFee;
  if (String(consentText || "").trim() !== downloadConsentPhrase) {
    throw downloadGateError("CONSENT_REQUIRED", "نص الموافقة الصريح الكامل مطلوب لإنشاء موافقة التنزيل؛ لا موافقة ضمنية أو آلية.");
  }
  return true;
}

// يقيّم صلاحية موافقة موجودة: منتهية، مستخدمة، ملغاة، أو مختلفة البصمة.
export function assessApprovalUsability(approval, { scopeHash, now = new Date() } = {}) {
  if (!approval) return { usable: false, code: "APPROVAL_NOT_FOUND", message: "الموافقة غير موجودة." };
  if (approval.revokedAt || approval.status === "revoked") {
    return { usable: false, code: "APPROVAL_REVOKED", message: "أُلغيت هذه الموافقة." };
  }
  if (approval.consumedAt || approval.status === "consumed") {
    return { usable: false, code: "APPROVAL_CONSUMED", message: "استُخدمت هذه الموافقة بالفعل؛ الموافقة تُستخدم مرة واحدة." };
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= nowMs) {
    return { usable: false, code: "APPROVAL_EXPIRED", message: "انتهت صلاحية الموافقة بعد 10 دقائق؛ اطلب موافقة جديدة." };
  }
  if (!approval.scopeHash || !approval.expiresAt || !approval.requestedAt) {
    return { usable: false, code: "APPROVAL_REVOKED", message: "هذه موافقة قديمة بلا نطاق أو انتهاء، وقد أُبطلت احترازيًا." };
  }
  if (scopeHash && approval.scopeHash !== scopeHash) {
    return { usable: false, code: "APPROVAL_SCOPE_MISMATCH", message: "تغيّرت قائمة الملفات عن بصمة الموافقة؛ أي تغيير في manifest يلغيها." };
  }
  return { usable: true, code: null, message: null };
}
