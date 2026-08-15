// منشئ حزمة التعافي المحايدة — P4-H1A.
// يبني الحزمة في مجلد staging مجاور ثم ينقلها ذريًا باسمها النهائي. عند أي
// فشل يترك مجلد الإخراج حاملًا علامة BUNDLE_FAILED.txt فقط — بلا manifest —
// فلا يمكن وصف الحزمة بأنها صالحة ولا أن تجتاز التحقق.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileAtomic,
  existsSync,
  isInside,
  listFilesRecursively,
  sha256File,
  writeFileAtomic,
} from "./recovery-files.mjs";
import { quickCheckSqlite, readContinuityState, readGitState, readSqliteState } from "./recovery-state.mjs";
import { renderResumeHere } from "./recovery-resume.mjs";
import { assertNoGateViolations, collectGateViolations } from "./recovery-secrets.mjs";

export const bundleLayout = {
  manifest: "manifest.json",
  sums: "SHA256SUMS",
  failedMarker: "BUNDLE_FAILED.txt",
  resume: "RESUME_HERE.md",
  gitBundle: "repo.bundle",
  database: "database.sqlite",
  guide: "docs/RECOVERY_BUNDLE.md",
  executorPrompt: "docs/REPLACEMENT_EXECUTOR_PROMPT.md",
  supervisorPrompt: "docs/REPLACEMENT_SUPERVISOR_PROMPT.md",
};

const manifestVersion = "recovery-bundle-manifest-v1";

export class RecoveryBundleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryBundleError";
    this.code = "recovery-bundle";
    Object.assign(this, details);
  }
}

// نسخة SQLite متسقة عبر VACUUM INTO من اتصال قراءة فقط — ليست نسخًا مباشرًا
// لملف قاعدة مفتوح. الوجهة يجب ألا تكون موجودة.
function backupSqliteConsistent(sourcePath, targetPath) {
  let database;
  try {
    database = new DatabaseSync(sourcePath, { readOnly: true });
  } catch (error) {
    throw new RecoveryBundleError("تعذر فتح قاعدة SQLite المصدر للقراءة فقط", { stage: "sqlite-backup", cause: error.message });
  }
  try {
    const escaped = targetPath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } catch (error) {
    throw new RecoveryBundleError("فشل إنشاء نسخة SQLite المتسقة (VACUUM INTO)", { stage: "sqlite-backup", cause: error.message });
  } finally {
    database.close();
  }
}

// ينشئ Git bundle لفرع main إلى اسم مؤقت ثم ينقله ذريًا.
function createGitBundle(projectRoot, targetPath) {
  const temporary = `${targetPath}.tmp-${process.pid}`;
  try {
    execFileSync("git", ["-C", projectRoot, "bundle", "create", temporary, "refs/heads/main"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", projectRoot, "bundle", "verify", temporary], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new RecoveryBundleError("فشل إنشاء Git bundle لفرع main أو التحقق منه", { stage: "git-bundle", cause: error.message });
  }
  return rename(temporary, targetPath);
}

export async function createRecoveryBundle({ projectRoot, sqlitePath, outputDir, continuityStatePath, docsDir, now }) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedSqlite = path.resolve(sqlitePath);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedState = path.resolve(continuityStatePath ?? path.join(resolvedRoot, "docs", "continuity", "CURRENT_STATE.json"));
  const resolvedDocs = path.resolve(docsDir ?? path.join(resolvedRoot, "docs", "continuity"));
  const createdAt = (now ?? new Date()).toISOString();

  // علامة الفشل تُكتب فقط لفشل مرحلة البناء (بعد نجاح التحقق من المدخلات).
  // فشل التحقق المبكر يرمي خطأً مباشرة دون إنشاء مجلد الإخراج أو لمس مجلد موجود.
  const fail = async (stage, message, cause) => {
    await mkdir(resolvedOutput, { recursive: true });
    await writeFileAtomic(path.join(resolvedOutput, bundleLayout.failedMarker), `BUNDLE_FAILED\nstage: ${stage}\nmessage: ${message}\n`);
    throw new RecoveryBundleError(message, { stage, cause });
  };

  let stagingDir = null;
  try {
    // التحقق من المدخلات الصريحة — الفشل هنا لا ينشئ شيئًا.
    if (!existsSync(resolvedRoot) || !(await stat(resolvedRoot)).isDirectory()) {
      throw new RecoveryBundleError("مجلد المشروع المصدر مفقود", { stage: "validation" });
    }
    if (!existsSync(resolvedSqlite) || !(await stat(resolvedSqlite)).isFile()) {
      throw new RecoveryBundleError("ملف SQLite المصدر مفقود", { stage: "validation" });
    }
    if (existsSync(resolvedOutput)) {
      throw new RecoveryBundleError("مجلد الإخراج موجود مسبقًا — يجب أن يُنشأ جديدًا", { stage: "validation" });
    }
    if (isInside(resolvedRoot, resolvedOutput)) {
      throw new RecoveryBundleError("مجلد الإخراج داخل مجلد المشروع — قد يلوث Git", { stage: "validation" });
    }
    if (!existsSync(resolvedState)) {
      throw new RecoveryBundleError("وثيقة حالة continuity المنظمة مفقودة", { stage: "validation" });
    }

    // قراءة الحالة الفعلية: Git ثم وثيقة continuity — فشلها يترك علامة واضحة.
    let gitState;
    try {
      gitState = readGitState(resolvedRoot);
    } catch (error) {
      return await fail("git", error.message, error.cause);
    }
    let continuityState;
    try {
      continuityState = await readContinuityState(resolvedState);
    } catch (error) {
      return await fail("continuity-state", error.message, error.cause);
    }

    // الوثائق المحايدة المطلوب نسخها داخل الحزمة.
    const docSources = {
      [bundleLayout.guide]: path.join(resolvedDocs, "RECOVERY_BUNDLE.md"),
      [bundleLayout.executorPrompt]: path.join(resolvedDocs, "REPLACEMENT_EXECUTOR_PROMPT.md"),
      [bundleLayout.supervisorPrompt]: path.join(resolvedDocs, "REPLACEMENT_SUPERVISOR_PROMPT.md"),
    };
    const templatePath = path.join(resolvedDocs, "RESUME_HERE_TEMPLATE.md");
    for (const source of [...Object.values(docSources), templatePath]) {
      if (!existsSync(source)) {
        return await fail("validation-docs", `وثيقة continuity مطلوبة مفقودة: ${path.basename(source)}`);
      }
    }

    // staging مجاور لمجلد الإخراج (خارج مجلد المشروع بالضرورة).
    stagingDir = path.join(path.dirname(resolvedOutput), `.recovery-staging-${process.pid}-${Date.now()}`);
    await mkdir(path.join(stagingDir, "docs"), { recursive: true });
    await mkdir(path.join(stagingDir, "tools", "lib"), { recursive: true });

    // Git bundle لفرع main وتاريخه فقط — لا ملفات غير متتبعة.
    try {
      await createGitBundle(resolvedRoot, path.join(stagingDir, bundleLayout.gitBundle));
    } catch (error) {
      return await fail("git-bundle", error.message, error.cause);
    }

    // نسخة SQLite المتسقة، ثم قراءة الحالة من النسخة لا من الأصل.
    const databaseCopy = path.join(stagingDir, bundleLayout.database);
    try {
      backupSqliteConsistent(resolvedSqlite, databaseCopy);
      if (quickCheckSqlite(databaseCopy) !== "ok") {
        return await fail("sqlite-backup", "فشل PRAGMA quick_check على نسخة SQLite");
      }
    } catch (error) {
      if (error instanceof RecoveryBundleError) {
        return await fail(error.stage || "sqlite-backup", error.message, error.cause);
      }
      return await fail("sqlite-backup", "فشل إنشاء نسخة SQLite المتسقة", error.message);
    }
    const sqliteState = readSqliteState(databaseCopy);

    // RESUME_HERE من القالب والحالة الفعلية.
    const template = await readFile(templatePath, "utf8");
    let resume;
    try {
      resume = renderResumeHere(template, {
        state: continuityState,
        mainCommit: gitState.mainCommit,
        gitStatusSummary: gitState.clean ? "نظيفة" : `بها ${gitState.statusEntries} مدخلًا غير محفوظ`,
        schemaVersion: sqliteState.schemaVersion,
        tables: sqliteState.tables,
        createdAt,
      });
    } catch (error) {
      return await fail("resume-render", error.message, error.cause);
    }
    await writeFileAtomic(path.join(stagingDir, bundleLayout.resume), resume);

    // نسخ الوثائق المحايدة.
    for (const [relative, source] of Object.entries(docSources)) {
      await copyFileAtomic(source, path.join(stagingDir, ...relative.split("/")));
    }

    // نسخ أدوات التحقق لتكون مستقلة داخل الحزمة.
    await copyFileAtomic(path.join(resolvedRoot, "scripts", "verify-recovery-bundle.mjs"), path.join(stagingDir, "tools", "verify-recovery-bundle.mjs"));
    const toolsLibs = ["recovery-verify.mjs", "recovery-files.mjs", "recovery-state.mjs", "recovery-secrets.mjs", "recovery-bundle.mjs", "recovery-resume.mjs"];
    for (const lib of toolsLibs) {
      await copyFileAtomic(path.join(resolvedRoot, "scripts", "lib", lib), path.join(stagingDir, "tools", "lib", lib));
    }

    // بوابة الأسرار والمسارات الشخصية قبل توليد البيان الختامي.
    const stagedFiles = await listFilesRecursively(stagingDir);
    try {
      const violations = await collectGateViolations({ baseDir: stagingDir, relativeFiles: stagedFiles, sqlitePath: databaseCopy });
      assertNoGateViolations(violations);
    } catch (error) {
      return await fail("secrets-gate", error.message, error.cause);
    }

    // manifest.json: يسجل كل ملف نهائي عدا نفسه وعدا SHA256SUMS.
    const files = [];
    for (const relative of stagedFiles) {
      const absolute = path.join(stagingDir, ...relative.split("/"));
      const info = await stat(absolute);
      files.push({ path: relative, sha256: await sha256File(absolute), bytes: info.size });
    }
    const manifest = {
      manifestVersion,
      createdAt,
      projectName: continuityState.projectName,
      git: { bundleFile: bundleLayout.gitBundle, ref: "refs/heads/main", headCommit: gitState.mainCommit },
      database: { file: bundleLayout.database, schemaVersion: sqliteState.schemaVersion, tables: sqliteState.tables },
      continuity: {
        lastApprovedFunctionalPhase: continuityState.lastApprovedFunctionalPhase,
        continuityPackagePhase: continuityState.continuityPackagePhase,
        nextPlannedPhase: continuityState.nextPlannedPhase,
        databaseSchemaVersion: continuityState.databaseSchemaVersion,
      },
      documents: {
        resume: bundleLayout.resume,
        guide: bundleLayout.guide,
        executorPrompt: bundleLayout.executorPrompt,
        supervisorPrompt: bundleLayout.supervisorPrompt,
      },
      files,
      verifyCommand: "node tools/verify-recovery-bundle.mjs \".\"",
    };
    await writeFileAtomic(path.join(stagingDir, bundleLayout.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

    // SHA256SUMS: كل الملفات النهائية غير الدائرية (كل شيء عدا نفسه).
    const finalFiles = await listFilesRecursively(stagingDir);
    const sumsLines = [];
    for (const relative of finalFiles) {
      const absolute = path.join(stagingDir, ...relative.split("/"));
      sumsLines.push(`${await sha256File(absolute)}  ${relative}`);
    }
    await writeFileAtomic(path.join(stagingDir, bundleLayout.sums), `${sumsLines.join("\n")}\n`);

    // النقل الذري النهائي.
    await rename(stagingDir, resolvedOutput);
    stagingDir = null;

    return {
      outputDir: resolvedOutput,
      manifest,
      summary: {
        outputDir: resolvedOutput,
        headCommit: gitState.mainCommit,
        schemaVersion: sqliteState.schemaVersion,
        tables: Object.keys(sqliteState.tables).length,
        files: manifest.files.length + 2,
      },
    };
  } finally {
    if (stagingDir) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}
