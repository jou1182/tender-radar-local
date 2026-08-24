// أدوات صيانة قاعدة بيانات الرادار — P4-O0A
// النسخ الاحتياطي عبر "VACUUM INTO": لقطة مدمجة متسقة تشمل محتوى الـWAL ملتزمًا،
// ويفشل أصلًا إن كان الملف الهدف موجودًا (طبقة حماية فوق فحصنا الصريح).
// لا حذف ولا استبدال لأي ملف موجود أبدًا (SAFETY_BOUNDARIES: التوقف الآمن عند الشك).
import path from "node:path";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// عتبة تجاوز checkpoint التلقائي: لا داعي لاختصار ملف أصغر من هذه القيمة.
const walAutoCheckpointMinBytes = 64 * 1024;

export function defaultDatabasePath(projectRoot) {
  return path.join(projectRoot, ".radar-data", "radar.sqlite");
}

async function walSizeBytes(databasePath) {
  try {
    return (await stat(`${databasePath}-wal`)).size;
  } catch {
    return 0;
  }
}

// يختصر الـWAL المصدر عند وجوده بحجم يستحق العملية؛ يتجاوز بأمان ما عداه.
// القرار (exists/size) والتنفيذ منفصلان لسهولة الاختبار — بلا أي حذف للملف أبدًا.
export async function maybeTruncateWal(databasePath, { minBytes = walAutoCheckpointMinBytes } = {}) {
  const sizeBefore = await walSizeBytes(databasePath);
  if (!existsSync(`${databasePath}-wal`) || sizeBefore < minBytes) {
    return { attempted: false, skipped: true, walBytesBefore: sizeBefore };
  }
  const handle = new DatabaseSync(databasePath);
  try {
    handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    handle.close();
  }
  const walBytesAfter = existsSync(`${databasePath}-wal`) ? await walSizeBytes(databasePath) : 0;
  return { attempted: true, skipped: false, walBytesBefore: sizeBefore, walBytesAfter };
}

// نقطة النداء الوحيدة من خدمة المزامنة: بعد saveCompletedSync فقط عندما status=complete.
// فشل الاختصار لا يفشل الجولة أبدًا — يسجل كتحذير داخل النتيجة.
export async function truncateSourceWalAfterCompleteRun({ databasePath, runStatus, minBytes }) {
  if (runStatus !== "complete") {
    return { attempted: false, reason: `run-status-${runStatus}` };
  }
  try {
    return await maybeTruncateWal(databasePath, minBytes ? { minBytes } : undefined);
  } catch (error) {
    return { attempted: false, warning: String(error?.message || error) };
  }
}

// حماية الهدف: يُمنع استهداف قاعدة التشغيل الحية نفسها أو ملفات -wal/-shm التابعة لها.
// المسارات خارج جذر المشروع مسموحة عمدًا وفق OPERATIONS_RUNBOOK («خارج PROJECT_ROOT أو
// في مجلد مستبعد من Git»)؛ الاستبدال ممنوع دائمًا عبر فحص الوجود + رفض VACUUM INTO الأصلي.
function assertSafeBackupTarget(databasePath, targetPath) {
  const normalizedTarget = path.resolve(targetPath).toLowerCase();
  const protectedPaths = [
    path.resolve(databasePath),
    `${path.resolve(databasePath)}-wal`,
    `${path.resolve(databasePath)}-shm`,
  ].map((value) => value.toLowerCase());
  if (protectedPaths.includes(normalizedTarget)) {
    throw Object.assign(
      new Error("backup target must not be the live database or its wal/shm sidecars"),
      { code: "BACKUP_TARGET_IS_LIVE_DATABASE" },
    );
  }
}

export async function createDatabaseBackup({
  projectRoot,
  databasePath = defaultDatabasePath(projectRoot),
  targetPath,
}) {
  if (!targetPath || !String(targetPath).trim()) {
    throw Object.assign(new Error("backup target path is required"), { code: "BACKUP_TARGET_REQUIRED" });
  }
  assertSafeBackupTarget(databasePath, targetPath);
  if (existsSync(targetPath)) {
    throw Object.assign(new Error(`backup target already exists: ${targetPath}`), {
      code: "BACKUP_TARGET_EXISTS",
    });
  }

  // المصدر يُفتح قراءة فقط؛ VACUUM INTO يقرأ اللقطة المتسقة (قاعدة + WAL) ولا يعدل شيئًا.
  const quotedTarget = String(targetPath).replace(/'/g, "''");
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${quotedTarget}'`);
  } finally {
    source.close();
  }

  // تحقق سلامة النسخة قبل أي خطوة لاحقة.
  const copyCheck = new DatabaseSync(targetPath, { readOnly: true });
  let integrity;
  let tableCount;
  try {
    integrity = copyCheck.prepare("PRAGMA quick_check").get().quick_check;
    tableCount = copyCheck
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
      .get().n;
  } finally {
    copyCheck.close();
  }
  if (integrity !== "ok") {
    throw Object.assign(
      new Error(`backup copy failed integrity check: ${integrity}`),
      { code: "BACKUP_INTEGRITY_FAILED" },
    );
  }
  if (!tableCount) {
    throw Object.assign(new Error("backup copy has no tables"), { code: "BACKUP_EMPTY" });
  }

  // checkpoint للـWAL المصدر بعد نجاح النسخ والتحقق فقط؛ TRUNCATE يُرجع طول ملف -wal
  // إلى الصفر ويبقي الملف موجودًا (سلوك SQLite الطبيعي). فشل الـcheckpoint لا يبطل
  // نسخة سليمة أصلًا، فيسجل كتحذير ولا يرفع استثناء.
  let walCheckpointAfterCopy;
  try {
    const walHandle = new DatabaseSync(databasePath);
    try {
      walHandle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      walCheckpointAfterCopy = { ok: true };
    } finally {
      walHandle.close();
    }
  } catch (error) {
    walCheckpointAfterCopy = { ok: false, error: String(error?.message || error) };
  }

  const targetStats = await stat(targetPath);
  return {
    databasePath,
    targetPath,
    bytes: targetStats.size,
    integrity,
    tableCount,
    walCheckpointAfterCopy,
  };
}
