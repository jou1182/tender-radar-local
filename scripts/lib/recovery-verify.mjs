// مدقق حزمة التعافي المحايدة — P4-H1A.
// ترتيب الفحوص متعمد: بصمات SHA‑256 قبل فتح Git bundle أو قاعدة SQLite، فأي
// عبث يُكتشف قبل تشغيل أي محتوى. كل الأعمال داخل مجلدات مؤقتة تُنظف دائمًا.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, isTextBundleFile, listFilesRecursively, sha256File } from "./recovery-files.mjs";
import { quickCheckSqlite, readSqliteState } from "./recovery-state.mjs";
import { assertNoGateViolations, collectGateViolations } from "./recovery-secrets.mjs";
import { bundleLayout } from "./recovery-bundle.mjs";

export class RecoveryVerifyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryVerifyError";
    this.code = "recovery-verify";
    Object.assign(this, details);
  }
}

function fail(stage, message, details = {}) {
  throw new RecoveryVerifyError(message, { stage, ...details });
}

function parseSums(content) {
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) {
      fail("sums-format", "سطر غير صالح في SHA256SUMS");
    }
    entries.push({ sha256: match[1], path: match[2] });
  }
  return entries;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    fail("manifest", "manifest.json ليس كائنًا");
  }
  if (manifest.manifestVersion !== "recovery-bundle-manifest-v1") {
    fail("manifest", "manifestVersion غير معروفة");
  }
  if (!manifest.git || !/^[0-9a-f]{40}$/.test(manifest.git.headCommit || "")) {
    fail("manifest", "git.headCommit مفقود أو غير صالح في manifest");
  }
  if (!manifest.database || typeof manifest.database !== "object" || typeof manifest.database.tables !== "object") {
    fail("manifest", "قسم database مفقود أو غير صالح في manifest");
  }
  if (!Array.isArray(manifest.files)) {
    fail("manifest", "قائمة files مفقودة في manifest");
  }
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256 || "") || typeof entry.bytes !== "number") {
      fail("manifest", "مدخل files غير صالح في manifest");
    }
    if (path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) {
      fail("manifest", "مسار غير نسبي داخل manifest");
    }
  }
}

export async function verifyRecoveryBundle({ bundleDir }) {
  const checks = [];
  const resolved = path.resolve(bundleDir);
  if (!existsSync(resolved)) {
    fail("missing", "مجلد الحزمة غير موجود");
  }

  // علامة الفشل أولًا: حزمة فاشلة لا يمكن أن تكون صالحة.
  if (existsSync(path.join(resolved, bundleLayout.failedMarker))) {
    fail("failed-marker", "الحزمة تحمل علامة BUNDLE_FAILED — ليست صالحة");
  }

  // manifest.
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(resolved, bundleLayout.manifest), "utf8"));
  } catch {
    fail("manifest", "تعذر قراءة manifest.json أو تحليله");
  }
  validateManifest(manifest);
  checks.push("manifest");

  // SHA256SUMS.
  let sumsEntries;
  try {
    sumsEntries = parseSums(await readFile(path.join(resolved, bundleLayout.sums), "utf8"));
  } catch (error) {
    if (error instanceof RecoveryVerifyError) throw error;
    fail("sums-format", "تعذر قراءة SHA256SUMS");
  }
  checks.push("sums-format");

  // مجموعة الملفات المتوقعة والفعلية: لا مفقود ولا زائد.
  const diskFiles = await listFilesRecursively(resolved);
  const manifestFiles = manifest.files.map((entry) => entry.path).sort();
  const expectedSet = new Set([...manifestFiles, bundleLayout.manifest, bundleLayout.sums]);
  const missing = [...expectedSet].filter((relative) => !diskFiles.includes(relative));
  if (missing.length) {
    fail("missing-file", `ملف مسجل مفقود من الحزمة: ${missing[0]}`, { missing });
  }
  const extra = diskFiles.filter((relative) => !expectedSet.has(relative));
  if (extra.length) {
    fail("unregistered-file", `ملف غير مسجل داخل الحزمة: ${extra[0]}`, { extra });
  }
  const sumsPaths = sumsEntries.map((entry) => entry.path).sort();
  const sumsExpected = [...expectedSet].filter((relative) => relative !== bundleLayout.sums).sort();
  if (JSON.stringify(sumsPaths) !== JSON.stringify(sumsExpected)) {
    fail("sums-coverage", "تغطية SHA256SUMS لا تطابق مجموعة الملفات المتوقعة");
  }
  if (JSON.stringify(manifestFiles) !== JSON.stringify(sumsExpected.filter((relative) => relative !== bundleLayout.manifest))) {
    fail("manifest-coverage", "تغطية manifest.files لا تطابق مجموعة الملفات المتوقعة");
  }
  checks.push("file-set");

  // إعادة حساب كل البصمات قبل فتح أي ملف ثنائي أو تشغيله.
  const sumsMap = new Map(sumsEntries.map((entry) => [entry.path, entry.sha256]));
  for (const relative of sumsPaths) {
    const actual = await sha256File(path.join(resolved, ...relative.split("/")));
    if (actual !== sumsMap.get(relative)) {
      fail("sha256", `عدم تطابق SHA‑256 للملف: ${relative}`);
    }
  }
  for (const entry of manifest.files) {
    if (sumsMap.get(entry.path) !== entry.sha256) {
      fail("sha256", `عدم تطابق بصمة manifest للملف: ${entry.path}`);
    }
  }
  checks.push("sha256");

  // Git bundle: تحقق ثم استنساخ داخل مجلد مؤقت يُنظف دائمًا.
  const bundlePath = path.join(resolved, bundleLayout.gitBundle);
  const workDir = mkdtempSync(path.join(tmpdir(), "recovery-verify-"));
  try {
    const scratch = path.join(workDir, "scratch");
    execFileSync("git", ["init", "-q", "-b", "main", scratch], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      execFileSync("git", ["-C", scratch, "bundle", "verify", bundlePath], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      fail("git-bundle-verify", "فشل git bundle verify");
    }
    const cloneDir = path.join(workDir, "clone");
    try {
      // --no-checkout ثم إنشاء فرع main المحلي من المرجع المستعاد: حتمي سواء
      // حمل الـbundle مرجع HEAD أم لم يحمله.
      execFileSync("git", ["clone", "-q", "--no-checkout", bundlePath, cloneDir], { stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["-C", cloneDir, "checkout", "-q", "-b", "main", "refs/remotes/origin/main"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      fail("git-clone", "تعذر استنساخ Git bundle داخل مجلد مؤقت");
    }
    const restoredHead = execFileSync("git", ["-C", cloneDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (restoredHead !== manifest.git.headCommit) {
      fail("git-head-mismatch", "HEAD المستعاد لا يطابق headCommit في manifest");
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  checks.push("git-bundle");

  // SQLite: quick_check ثم تطابق schemaVersion وأعداد السجلات.
  const databasePath = path.join(resolved, bundleLayout.database);
  if (quickCheckSqlite(databasePath) !== "ok") {
    fail("sqlite-quick-check", "PRAGMA quick_check لنسخة SQLite ليس ok");
  }
  checks.push("sqlite-quick-check");
  const sqliteState = readSqliteState(databasePath);
  if (sqliteState.schemaVersion !== manifest.database.schemaVersion) {
    fail("sqlite-schema-version", "schemaVersion المستعادة لا تطابق manifest");
  }
  const manifestTables = manifest.database.tables;
  const actualTables = sqliteState.tables;
  if (JSON.stringify(Object.keys(manifestTables).sort()) !== JSON.stringify(Object.keys(actualTables).sort())) {
    fail("sqlite-tables", "قائمة جداول SQLite لا تطابق manifest");
  }
  for (const [table, count] of Object.entries(manifestTables)) {
    if (actualTables[table] !== count) {
      fail("sqlite-table-counts", `عدد سجلات الجدول ${table} لا يطابق manifest`);
    }
  }
  checks.push("sqlite-counts");

  // الوثائق المطلوبة واتساق RESUME_HERE مع manifest.
  for (const relative of [bundleLayout.resume, bundleLayout.executorPrompt, bundleLayout.supervisorPrompt, bundleLayout.guide]) {
    if (!existsSync(path.join(resolved, ...relative.split("/")))) {
      fail("documents", `وثيقة مطلوبة مفقودة من الحزمة: ${relative}`);
    }
  }
  const resumeContent = await readFile(path.join(resolved, bundleLayout.resume), "utf8");
  if (!resumeContent.includes(manifest.git.headCommit)) {
    fail("resume-consistency", "RESUME_HERE لا يذكر headCommit المسجل في manifest");
  }
  checks.push("documents");

  // بوابة الأسرار والمسارات الشخصية على الحزمة النهائية.
  const violations = await collectGateViolations({ baseDir: resolved, relativeFiles: diskFiles, sqlitePath: databasePath });
  try {
    assertNoGateViolations(violations);
  } catch (error) {
    fail("secrets-gate", error.message);
  }
  checks.push("secrets-gate");

  return {
    ok: true,
    checks,
    details: {
      headCommit: manifest.git.headCommit,
      schemaVersion: sqliteState.schemaVersion,
      tables: sqliteState.tables,
      files: diskFiles.length,
    },
  };
}

export { isTextBundleFile };
