// مسارات تخزين المرفقات الآمنة داخل .radar-data/attachments/<tender-reference>/
// هذه الوحدة تحسب المسارات وتتحقق منها فقط؛ لا تكتب أي ملف في التشغيل الفعلي.
import path from "node:path";
import { createHash } from "node:crypto";

const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function attachmentStorageRoot(projectRoot) {
  return path.join(String(projectRoot), ".radar-data", "attachments");
}

export function attachmentTenderDir(projectRoot, tenderReference) {
  const reference = String(tenderReference || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(reference)) {
    throw storageError("INVALID_TENDER_REFERENCE", `مرجع المنافسة غير صالح لمسار التخزين: ${reference || "فارغ"}`);
  }
  return path.join(attachmentStorageRoot(projectRoot), reference);
}

// يمنع: ../ والمسارات المطلقة والأسماء المحجوزة وأي خروج عن مجلد المنافسة.
export function resolveAttachmentStoragePath(projectRoot, tenderReference, displayName) {
  const name = String(displayName || "").normalize("NFC").trim();
  if (!name) throw storageError("INVALID_STORAGE_PATH", "اسم الملف فارغ.");
  if (name === "." || name === "..") throw storageError("INVALID_STORAGE_PATH", `اسم ملف غير مقبول: ${name}`);
  if (path.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw storageError("INVALID_STORAGE_PATH", `المسارات المطلقة ممنوعة: ${name}`);
  }
  if (/[\\/]/.test(name)) throw storageError("INVALID_STORAGE_PATH", `اسم الملف يجب ألا يحتوي فواصل مسارات: ${name}`);
  const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) < 32);
  if (/[<>:"|?*]/.test(name) || hasControlCharacter || /[. ]$/.test(name)) {
    throw storageError("INVALID_STORAGE_PATH", `اسم الملف يحتوي محارف غير آمنة لنظام Windows: ${name}`);
  }
  if (windowsReservedNames.test(name)) throw storageError("INVALID_STORAGE_PATH", `اسم محجوز في نظام التشغيل: ${name}`);
  const dir = attachmentTenderDir(projectRoot, tenderReference);
  const extension = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const internalName = `${createHash("sha256").update(`${tenderReference}\0${name}`).digest("hex")}${extension}`;
  const resolved = path.resolve(dir, internalName);
  const base = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw storageError("INVALID_STORAGE_PATH", `مسار يتجاوز مجلد التخزين: ${name}`);
  }
  return resolved;
}
