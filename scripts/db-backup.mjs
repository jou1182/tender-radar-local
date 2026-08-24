// CLI النسخ الاحتياطي الآمن — P4-O0A
// الاستخدام: node scripts/db-backup.mjs [--out <path|dir>]
// - بلا --out: يكتب داخل .radar-data/backups باسم radar-backup-<UTC timestamp>.sqlite
// - لا يستبدل أي ملف موجود أبدًا (BACKUP_TARGET_EXISTS) — يوقف ولا يكتب فوق شيء.
// - لا يحذف نسخًا قديمة ولا يمس قاعدة التشغيل كتابةً إلا checkpoint آمن بعد نجاح النسخ.
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabaseBackup } from "./lib/db-maintenance.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// RADAR_DB_ROOT يوجّه النسخ إلى قاعدة معزولة (للاختبارات) دون لمس قاعدة التشغيل،
// على نسق RADAR_DB_INIT_ROOT المعتمد في initialize-database.mjs.
const projectRoot = process.env.RADAR_DB_ROOT ? path.resolve(process.env.RADAR_DB_ROOT) : scriptRoot;

function parseArgs(argv) {
  const args = { out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--out") {
      i += 1;
      args.out = argv[i];
      continue;
    }
    if (token.startsWith("--out=")) {
      args.out = token.slice("--out=".length);
      continue;
    }
    throw Object.assign(new Error(`unknown argument: ${token}`), { code: "UNKNOWN_ARGUMENT" });
  }
  return args;
}

function timestampUtc(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

async function resolveTargetPath(outPath) {
  if (!outPath) {
    const backupDir = path.join(projectRoot, ".radar-data", "backups");
    await mkdir(backupDir, { recursive: true });
    return path.join(backupDir, `radar-backup-${timestampUtc()}.sqlite`);
  }
  const resolvedOut = path.resolve(projectRoot, outPath);
  let statResult;
  try {
    statResult = await stat(resolvedOut);
  } catch {
    statResult = null;
  }
  if (statResult?.isDirectory()) {
    return path.join(resolvedOut, `radar-backup-${timestampUtc()}.sqlite`);
  }
  return resolvedOut;
}

const args = parseArgs(process.argv.slice(2));
try {
  const targetPath = await resolveTargetPath(args.out);
  const result = await createDatabaseBackup({ projectRoot, targetPath });
  console.log(JSON.stringify({
    ok: true,
    backup: result.targetPath,
    bytes: result.bytes,
    integrity: result.integrity,
    tables: result.tableCount,
    walCheckpointAfterCopy: result.walCheckpointAfterCopy,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    errorCode: error?.code || "BACKUP_FAILED",
    message: String(error?.message || error),
  }, null, 2));
  process.exitCode = 1;
}
