// اختبارات P4-H1A: أدوات حزمة التعافي المحايدة.
// كل شيء هنا fixtures اصطناعية داخل مجلدات مؤقتة: مستودع Git اصطناعي وقاعدة
// SQLite اصطناعية. لا شبكة، لا خدمات حية، لا فتح لقاعدة التشغيل، ولا صناعة
// حزمة حقيقية من المشروع الرئيسي.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleLayout, createRecoveryBundle } from "../scripts/lib/recovery-bundle.mjs";
import { listFilesRecursively, sha256File } from "../scripts/lib/recovery-files.mjs";
import { assertTemplateHasNoHardcodedState } from "../scripts/lib/recovery-resume.mjs";
import { quickCheckSqlite, readSqliteState } from "../scripts/lib/recovery-state.mjs";
import { verifyRecoveryBundle } from "../scripts/lib/recovery-verify.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const realDocsDir = path.join(root, "docs", "continuity");
const bundleDocFiles = [
  "RECOVERY_BUNDLE.md",
  "REPLACEMENT_EXECUTOR_PROMPT.md",
  "REPLACEMENT_SUPERVISOR_PROMPT.md",
  "RESUME_HERE_TEMPLATE.md",
];

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitCommitAll(cwd, message) {
  execFileSync("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "-A"], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", message], { stdio: ["ignore", "pipe", "pipe"] });
}

// استعادة حتمية من bundle: استنساخ بلا checkout ثم فرع main من المرجع المستعاد.
function restoreClone(bundlePath, destination) {
  execFileSync("git", ["clone", "-q", "--no-checkout", bundlePath, destination], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-C", destination, "checkout", "-q", "-b", "main", "refs/remotes/origin/main"], { stdio: ["ignore", "pipe", "pipe"] });
}

function makeFixtureState(overrides = {}) {
  return {
    stateSchemaVersion: "neutral-continuity-state-v1",
    projectName: "tender-radar-local",
    functionalBaselineCommit: "0123456789abcdef0123456789abcdef01234567",
    lastApprovedFunctionalPhase: "P4-FIXA",
    continuityPackagePhase: "P4-HFIX",
    databaseSchemaVersion: 7,
    testBaselines: {
      functionalBaseline: { commit: "0123456789abcdef0123456789abcdef01234567", passed: 143, failed: 0 },
      continuityPackage: { phase: "P4-HFIX", passed: 155, failed: 0 },
    },
    attachmentLiveStages: {
      p3b1b: {
        status: "approved_safe_stop",
        detailVerifiedFreeTenderFound: false,
        attachmentNameInspected: false,
        downloadElementInspected: false,
        approvalConsumed: false,
        fileDownloaded: false,
        resumeCondition: "العثور على منافسة تؤكد صفحة تفاصيلها الموثوقة أن قيمة الكراسة صفر",
      },
      p3b1c: { status: "paused", reason: "تحتاج موافقة بشرية جديدة بعد P3-B1B" },
    },
    pendingHumanGates: ["بوابة اختبارية أولى", "بوابة اختبارية ثانية"],
    nextPlannedPhase: "P4-MFIX",
    ...overrides,
  };
}

function makeFixtureDb(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, applied_at) VALUES (5, 't'), (6, 't'), (7, 't');
    CREATE TABLE tenders (reference TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO tenders (reference, title) VALUES ('R1', 'أ'), ('R2', 'ب'), ('R3', 'ج');
    CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT '');
    INSERT INTO sync_runs (status) VALUES ('ok'), ('ok');
  `);
  database.close();
}

// يبني مستودعًا اصطناعيًا (ينسخ الوثائق المحايدة الحقيقية ويضع حالة fixture)
// وقاعدة اصطناعية، ثم ينشئ الحزمة. كل شيء داخل مجلد مؤقت يُنظف بعد الاختبار.
async function arrangeBundle(t, { stateOverrides } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "p4h1a-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const repoDir = path.join(base, "repo");
  await mkdir(path.join(repoDir, "docs", "continuity"), { recursive: true });
  for (const doc of bundleDocFiles) {
    await cp(path.join(realDocsDir, doc), path.join(repoDir, "docs", "continuity", doc));
  }
  const state = makeFixtureState(stateOverrides);
  await writeFile(path.join(repoDir, "docs", "continuity", "CURRENT_STATE.json"), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(path.join(repoDir, "AGENTS.md"), "# fixture repo\n");
  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: ["ignore", "pipe", "pipe"] });
  gitCommitAll(repoDir, "fixture commit");
  const head = git(repoDir, ["rev-parse", "refs/heads/main"]);
  const dbPath = path.join(base, "source.sqlite");
  makeFixtureDb(dbPath);
  const bundleDir = path.join(base, "bundle");
  const result = await createRecoveryBundle({ projectRoot: repoDir, sqlitePath: dbPath, outputDir: bundleDir });
  return { base, repoDir, dbPath, bundleDir, head, state, result };
}

async function flipByte(filePath, offset = 100) {
  const handle = await open(filePath, "r+");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, offset);
    buffer[0] = buffer[0] ^ 0xff;
    await handle.write(buffer, 0, 1, offset);
  } finally {
    await handle.close();
  }
}

// يعيد حساب manifest.files وSHA256SUMS بعد عبث مقصود — لاختبار البوابات
// اللاحقة (أسرار/مسارات) بمعزل عن فشل البصمات.
async function rehashBundle(bundleDir) {
  const manifestPath = path.join(bundleDir, bundleLayout.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const all = await listFilesRecursively(bundleDir);
  manifest.files = [];
  for (const relative of all) {
    if (relative === bundleLayout.manifest || relative === bundleLayout.sums) continue;
    const absolute = path.join(bundleDir, ...relative.split("/"));
    manifest.files.push({ path: relative, sha256: await sha256File(absolute), bytes: (await stat(absolute)).size });
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lines = [];
  for (const relative of await listFilesRecursively(bundleDir)) {
    if (relative === bundleLayout.sums) continue;
    lines.push(`${await sha256File(path.join(bundleDir, ...relative.split("/")))}  ${relative}`);
  }
  await writeFile(path.join(bundleDir, bundleLayout.sums), `${lines.join("\n")}\n`);
}

test("1) إنشاء حزمة من مستودع وقاعدة اصطناعيين ينجح ويجتاز التحقق، ويُرفض الإخراج داخل المشروع", async (t) => {
  const { bundleDir, result } = await arrangeBundle(t);
  for (const relative of [bundleLayout.manifest, bundleLayout.sums, bundleLayout.resume, bundleLayout.gitBundle, bundleLayout.database, bundleLayout.guide, bundleLayout.executorPrompt, bundleLayout.supervisorPrompt]) {
    assert.ok(existsSync(path.join(bundleDir, ...relative.split("/"))), `${relative} موجود في الحزمة`);
  }
  assert.equal(result.manifest.manifestVersion, "recovery-bundle-manifest-v1");
  assert.equal(result.manifest.verifyCommand, 'npm run recovery:verify -- "<RECOVERY_BUNDLE_DIR>"');
  const verification = await verifyRecoveryBundle({ bundleDir });
  assert.equal(verification.ok, true);
  // يرفض مجلد إخراج داخل مجلد المشروع (حتى لا يلوث Git).
  await assert.rejects(
    createRecoveryBundle({ projectRoot: path.join(bundleDir, "..", "repo"), sqlitePath: path.join(bundleDir, "..", "source.sqlite"), outputDir: path.join(path.resolve(bundleDir, "..", "repo"), "bundle-out") }),
    (error) => error.stage === "validation",
  );
  // يرفض مجلد إخراج موجودًا مسبقًا.
  await assert.rejects(
    createRecoveryBundle({ projectRoot: path.resolve(bundleDir, "..", "repo"), sqlitePath: path.resolve(bundleDir, "..", "source.sqlite"), outputDir: bundleDir }),
    (error) => error.stage === "validation",
  );
});

test("2) Git bundle داخل الحزمة قابل للتحقق والاستنساخ", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  const scratch = await mkdtemp(path.join(tmpdir(), "p4h1a-git-"));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  const scratchRepo = path.join(scratch, "scratch");
  execFileSync("git", ["init", "-q", "-b", "main", scratchRepo], { stdio: ["ignore", "pipe", "pipe"] });
  const bundlePath = path.join(bundleDir, bundleLayout.gitBundle);
  assert.doesNotThrow(() => git(scratchRepo, ["bundle", "verify", bundlePath]), "git bundle verify ينجح");
  restoreClone(bundlePath, path.join(scratch, "clone"));
  assert.ok(existsSync(path.join(scratch, "clone", "AGENTS.md")), "الاستنساخ من الحزمة ينجح");
});

test("3) HEAD المستعاد من الحزمة يساوي Hash المصدر", async (t) => {
  const { bundleDir, head } = await arrangeBundle(t);
  const scratch = await mkdtemp(path.join(tmpdir(), "p4h1a-head-"));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  restoreClone(path.join(bundleDir, bundleLayout.gitBundle), path.join(scratch, "clone"));
  const restored = git(path.join(scratch, "clone"), ["rev-parse", "HEAD"]);
  assert.equal(restored, head, "HEAD المستعاد يساوي Hash المصدر");
  const verification = await verifyRecoveryBundle({ bundleDir });
  assert.equal(verification.details.headCommit, head);
});

test("4) نسخة SQLite داخل الحزمة quick_check = ok وschemaVersion = 7", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  const databasePath = path.join(bundleDir, bundleLayout.database);
  assert.equal(quickCheckSqlite(databasePath), "ok");
  assert.equal(readSqliteState(databasePath).schemaVersion, 7);
});

test("5) أعداد الجداول والسجلات في النسخة تطابق المصدر", async (t) => {
  const { bundleDir, dbPath, result } = await arrangeBundle(t);
  const source = readSqliteState(dbPath);
  const copy = readSqliteState(path.join(bundleDir, bundleLayout.database));
  assert.deepEqual(copy.tables, source.tables, "أعداد السجلات قبل وبعد متطابقة");
  assert.deepEqual(result.manifest.database.tables, source.tables, "manifest يسجل الأعداد نفسها");
  assert.deepEqual(source.tables, { schema_migrations: 3, sync_runs: 2, tenders: 3 });
});

test("6) تغيير بايت واحد في Git bundle يفشل التحقق", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  await flipByte(path.join(bundleDir, bundleLayout.gitBundle));
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "sha256");
    assert.match(error.message, /repo\.bundle/);
    return true;
  });
});

test("7) تغيير بايت واحد في SQLite يفشل SHA‑256 قبل محاولة فتحها", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  await flipByte(path.join(bundleDir, bundleLayout.database));
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "sha256", "الفشل في مرحلة البصمات قبل فتح القاعدة");
    assert.match(error.message, /database\.sqlite/);
    return true;
  });
});

test("8) تعديل manifest يفشل التحقق", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  const manifestPath = path.join(bundleDir, bundleLayout.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.continuity.nextPlannedPhase = "P4-TAMPERED";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "sha256");
    assert.match(error.message, /manifest\.json/);
    return true;
  });
});

test("9) حذف ملف مسجل يفشل التحقق", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  await unlink(path.join(bundleDir, ...bundleLayout.guide.split("/")));
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "missing-file");
    assert.match(error.message, /RECOVERY_BUNDLE\.md/);
    return true;
  });
});

test("10) إضافة ملف غير مسجل تفشل التحقق", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  await writeFile(path.join(bundleDir, "unexpected.txt"), "عبث\n");
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "unregistered-file");
    assert.match(error.message, /unexpected\.txt/);
    return true;
  });
});

test("11) تغيير SHA256SUMS يفشل التحقق", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  const sumsPath = path.join(bundleDir, bundleLayout.sums);
  const content = await readFile(sumsPath, "utf8");
  const lines = content.trim().split("\n");
  // تعديل حتمي: قلب أول محرف hex في أول سطر.
  const firstChar = lines[0][0];
  lines[0] = (firstChar === "a" ? "b" : "a") + lines[0].slice(1);
  await writeFile(sumsPath, `${lines.join("\n")}\n`);
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "sha256");
    return true;
  });
});

test("12) وجود سر أو ملف .env يفشل دون طباعة القيمة (إنشاءً وتحققًا)", async (t) => {
  // جانب التحقق: ملف نصي بسر مع بصمات محدثة يجب أن ترفضه البوابة.
  const { bundleDir } = await arrangeBundle(t);
  const secretValue = "AKIA-VERY-SECRET-VALUE-123456";
  await writeFile(path.join(bundleDir, "notes.txt"), `ملاحظة: api_key = "${secretValue}"\n`);
  await rehashBundle(bundleDir);
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "secrets-gate");
    assert.match(error.message, /notes\.txt/, "يعرض مسار الملف");
    assert.ok(!error.message.includes(secretValue), "لا يعرض قيمة السر");
    return true;
  });
  // ملف .env ممنوع بالاسم.
  const second = await arrangeBundle(t);
  await writeFile(path.join(second.bundleDir, ".env"), "SOME_PRIVATE_VALUE=hunter2secret\n");
  await rehashBundle(second.bundleDir);
  await assert.rejects(verifyRecoveryBundle({ bundleDir: second.bundleDir }), (error) => {
    assert.equal(error.stage, "secrets-gate");
    assert.match(error.message, /\.env/);
    assert.ok(!error.message.includes("hunter2secret"), "لا يعرض قيمة ملف البيئة");
    return true;
  });
  // جانب الإنشاء: عمود SQLite باسم ممنوع يرفض الإنشاء كله.
  const third = await arrangeBundle(t);
  const badDb = path.join(third.base, "bad.sqlite");
  const database = new DatabaseSync(badDb);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (7, 't'); CREATE TABLE unsafe (id INTEGER PRIMARY KEY, api_token TEXT);");
  database.close();
  await assert.rejects(
    createRecoveryBundle({ projectRoot: third.repoDir, sqlitePath: badDb, outputDir: path.join(third.base, "bundle-bad") }),
    (error) => {
      assert.equal(error.stage, "secrets-gate");
      assert.match(error.message, /unsafe\.api_token/, "يعرض اسم الحقل فقط");
      return true;
    },
  );
});

test("13) وجود مسار شخصي (مستخدم Windows أو home) يفشل دون كشف الاسم", async (t) => {
  const { bundleDir } = await arrangeBundle(t);
  await writeFile(path.join(bundleDir, "paths.txt"), "المسار: C:\\Users\\SecretName\\project\n");
  await rehashBundle(bundleDir);
  await assert.rejects(verifyRecoveryBundle({ bundleDir }), (error) => {
    assert.equal(error.stage, "secrets-gate");
    assert.match(error.message, /paths\.txt/);
    assert.ok(!error.message.includes("SecretName"), "لا يكشف اسم المستخدم المكتشف");
    return true;
  });
  const second = await arrangeBundle(t);
  await writeFile(path.join(second.bundleDir, "paths.txt"), "المسار: /home/hiddenname/project\n");
  await rehashBundle(second.bundleDir);
  await assert.rejects(verifyRecoveryBundle({ bundleDir: second.bundleDir }), (error) => {
    assert.equal(error.stage, "secrets-gate");
    assert.ok(!error.message.includes("hiddenname"), "لا يكشف اسم مستخدم لينكس");
    return true;
  });
});

test("14) RESUME_HERE يعكس Hash والمرحلة وschema الفعلية", async (t) => {
  const { bundleDir, head } = await arrangeBundle(t);
  const resume = await readFile(path.join(bundleDir, bundleLayout.resume), "utf8");
  assert.match(resume, new RegExp(head), "يذكر Hash رأس main الفعلي");
  assert.match(resume, /P4-FIXA/, "يذكر آخر مرحلة وظيفية من الحالة");
  assert.match(resume, /P4-HFIX/, "يذكر مرحلة حزمة الاستمرارية");
  assert.match(resume, /P4-MFIX/, "يذكر المرحلة التالية المخططة");
  assert.match(resume, /schemaVersion المسجلة: 7/, "يذكر schemaVersion الفعلية");
  assert.match(resume, /approved_safe_stop/, "يوثق حالة التوقف الآمن المعتمد");
  assert.match(resume, /paused/, "يوثق توقف P3-B1C");
  assert.match(resume, /لم تبدأ/, "يوثق أن المرحلة التالية لم تبدأ");
  assert.match(resume, /tenders: 3/, "يذكر أعداد السجلات الفعلية");
  assert.doesNotMatch(resume, /\{\{[A-Z_]+\}\}/, "لا عناصر نائبة متبقية");
});

test("15) تغيير الحالة في fixture ينعكس في الحزمة الجديدة، والقالب بلا حالة ثابتة", async (t) => {
  const first = await arrangeBundle(t);
  const stateV2 = makeFixtureState({ lastApprovedFunctionalPhase: "P4-FIXB", nextPlannedPhase: "P4-MFIX2" });
  await writeFile(path.join(first.repoDir, "docs", "continuity", "CURRENT_STATE.json"), `${JSON.stringify(stateV2, null, 2)}\n`);
  gitCommitAll(first.repoDir, "state v2");
  const headV2 = git(first.repoDir, ["rev-parse", "refs/heads/main"]);
  const bundleDirV2 = path.join(first.base, "bundle-v2");
  const second = await createRecoveryBundle({ projectRoot: first.repoDir, sqlitePath: first.dbPath, outputDir: bundleDirV2 });
  const resumeV1 = await readFile(path.join(first.bundleDir, bundleLayout.resume), "utf8");
  const resumeV2 = await readFile(path.join(bundleDirV2, bundleLayout.resume), "utf8");
  assert.notEqual(resumeV2, resumeV1, "RESUME_HERE يتغير بتغير الحالة");
  assert.match(resumeV2, /P4-FIXB/, "يعكس المرحلة الجديدة");
  assert.doesNotMatch(resumeV2, /P4-FIXA/, "لا يبقى أثر المرحلة القديمة");
  assert.match(resumeV2, new RegExp(headV2), "يعكس Hash الجديد");
  assert.equal(second.manifest.git.headCommit, headV2);
  assert.equal(second.manifest.continuity.lastApprovedFunctionalPhase, "P4-FIXB");
  assert.notEqual(second.manifest.git.headCommit, first.result.manifest.git.headCommit);
  // القالب نفسه بلا حالة قديمة ثابتة.
  const template = await readFile(path.join(realDocsDir, "RESUME_HERE_TEMPLATE.md"), "utf8");
  assertTemplateHasNoHardcodedState(template);
  assert.throws(() => assertTemplateHasNoHardcodedState(`${template}\n${"a".repeat(40)}\n`), /Hash/);
  assert.throws(() => assertTemplateHasNoHardcodedState(`${template}\nP4-A1D0M\n`), /مرحلة/);
});

test("16) رسالتا البدلاء موجودتان ومحايدتان عن أسماء المزودين", async () => {
  const executor = await readFile(path.join(realDocsDir, "REPLACEMENT_EXECUTOR_PROMPT.md"), "utf8");
  const supervisor = await readFile(path.join(realDocsDir, "REPLACEMENT_SUPERVISOR_PROMPT.md"), "utf8");
  assert.match(executor, /EXECUTOR/, "رسالة المنفّذ تعرّف دور EXECUTOR");
  assert.match(supervisor, /SUPERVISOR/, "رسالة المشرف تعرّف دور SUPERVISOR");
  for (const [name, content] of [["executor", executor], ["supervisor", supervisor]]) {
    assert.doesNotMatch(content, /Kimi|Codex|Gemini|Claude/i, `${name}: لا أسماء مزودين`);
    assert.doesNotMatch(content, /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/i, `${name}: لا مسارات Windows شخصية`);
    assert.doesNotMatch(content, /\/home\/[A-Za-z0-9._-]+/, `${name}: لا مسارات home شخصية`);
    assert.ok(content.includes("<PROJECT_ROOT>"), `${name}: يستخدم العنصر النائب للمشروع`);
    assert.ok(content.includes("<HANDOFF_ROOT>"), `${name}: يستخدم العنصر النائب للتسليم`);
  }
});

test("17) الملفات غير المتتبعة لا تدخل الحزمة تلقائيًا", async (t) => {
  const { repoDir, base } = await arrangeBundle(t);
  await writeFile(path.join(repoDir, "local-notes.txt"), "ملاحظات محلية غير متتبعة\n");
  const bundleDir2 = path.join(base, "bundle-untracked");
  await createRecoveryBundle({ projectRoot: repoDir, sqlitePath: path.join(base, "source.sqlite"), outputDir: bundleDir2 });
  const scratch = path.join(base, "clone-check");
  restoreClone(path.join(bundleDir2, bundleLayout.gitBundle), scratch);
  assert.ok(!existsSync(path.join(scratch, "local-notes.txt")), "الملف غير المتتبع مستبعد من الحزمة");
  assert.ok(existsSync(path.join(scratch, "docs", "continuity", "CURRENT_STATE.json")), "الملفات المتتبعة موجودة");
  const resume = await readFile(path.join(bundleDir2, bundleLayout.resume), "utf8");
  assert.match(resume, /مدخلًا غير محفوظ/, "RESUME_HERE يسجل حالة الشجرة الفعلية");
});

test("18) فشل SQLite backup لا ينتج حزمة تحمل حالة valid", async (t) => {
  const { repoDir, base } = await arrangeBundle(t);
  const notSqlite = path.join(base, "not-a-database.sqlite");
  await writeFile(notSqlite, "هذا ليس ملف SQLite\n");
  const failedDir = path.join(base, "bundle-failed");
  await assert.rejects(
    createRecoveryBundle({ projectRoot: repoDir, sqlitePath: notSqlite, outputDir: failedDir }),
    (error) => error.stage === "sqlite-backup",
  );
  assert.ok(existsSync(path.join(failedDir, bundleLayout.failedMarker)), "علامة الفشل موجودة");
  assert.ok(!existsSync(path.join(failedDir, bundleLayout.manifest)), "لا manifest لحزمة فاشلة");
  const marker = await readFile(path.join(failedDir, bundleLayout.failedMarker), "utf8");
  assert.match(marker, /sqlite-backup/);
  await assert.rejects(verifyRecoveryBundle({ bundleDir: failedDir }), (error) => error.stage === "failed-marker");
});

test("19) فشل Git bundle لا ينتج حزمة valid", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "p4h1a-nogit-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  // مستودع بلا فرع main: فرعه trunk فقط.
  const repoDir = path.join(base, "repo");
  await mkdir(path.join(repoDir, "docs", "continuity"), { recursive: true });
  for (const doc of bundleDocFiles) {
    await cp(path.join(realDocsDir, doc), path.join(repoDir, "docs", "continuity", doc));
  }
  await writeFile(path.join(repoDir, "docs", "continuity", "CURRENT_STATE.json"), `${JSON.stringify(makeFixtureState(), null, 2)}\n`);
  execFileSync("git", ["init", "-q", "-b", "trunk", repoDir], { stdio: ["ignore", "pipe", "pipe"] });
  gitCommitAll(repoDir, "trunk commit");
  const dbPath = path.join(base, "source.sqlite");
  makeFixtureDb(dbPath);
  const failedDir = path.join(base, "bundle-failed");
  await assert.rejects(
    createRecoveryBundle({ projectRoot: repoDir, sqlitePath: dbPath, outputDir: failedDir }),
    (error) => error.stage === "git",
  );
  assert.ok(existsSync(path.join(failedDir, bundleLayout.failedMarker)), "علامة الفشل موجودة");
  assert.ok(!existsSync(path.join(failedDir, bundleLayout.manifest)), "لا manifest لحزمة فاشلة");
  await assert.rejects(verifyRecoveryBundle({ bundleDir: failedDir }), (error) => error.stage === "failed-marker");
});

test("20) أمر recovery:verify يعيد 0 للحزمة السليمة وغير صفر للمعدلة", async (t) => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["recovery:verify"], "node scripts/verify-recovery-bundle.mjs");
  const npmCmd = process.platform === "win32"
    ? (existsSync(path.join(path.dirname(process.execPath), "npm.cmd")) ? path.join(path.dirname(process.execPath), "npm.cmd") : "npm.cmd")
    : "npm";
  const runVerify = (bundleDir) => spawnSync("cmd.exe", ["/d", "/s", "/c", npmCmd, "run", "recovery:verify", "--", bundleDir], { cwd: root, encoding: "utf8" });
  const { bundleDir } = await arrangeBundle(t);
  const okRun = runVerify(bundleDir);
  assert.equal(okRun.status, 0, `الحزمة السليمة تعيد 0:\n${okRun.stdout}\n${okRun.stderr}`);
  const tampered = await arrangeBundle(t);
  await flipByte(path.join(tampered.bundleDir, bundleLayout.gitBundle));
  const badRun = runVerify(tampered.bundleDir);
  assert.notEqual(badRun.status, 0, "الحزمة المعدلة تعيد exit code غير صفري");
  assert.match(badRun.stdout, /"ok": false/, "المخرجات تسجل الفشل");
});

test("21) restore drill كامل داخل مجلد مؤقت ينجح ثم يُنظف بأمان", async (t) => {
  const { bundleDir, head } = await arrangeBundle(t);
  const drill = await mkdtemp(path.join(tmpdir(), "p4h1a-drill-"));
  const cloneDir = path.join(drill, "restored-repo");
  restoreClone(path.join(bundleDir, bundleLayout.gitBundle), cloneDir);
  assert.equal(git(cloneDir, ["rev-parse", "HEAD"]), head, "الرأس المستعاد مطابق");
  const restoredDb = path.join(drill, "restored.sqlite");
  await cp(path.join(bundleDir, bundleLayout.database), restoredDb);
  assert.equal(quickCheckSqlite(restoredDb), "ok");
  const resume = await readFile(path.join(bundleDir, bundleLayout.resume), "utf8");
  assert.match(resume, new RegExp(head));
  await rm(drill, { recursive: true, force: true });
  assert.ok(!existsSync(drill), "مجلد المحاكاة نُظف بالكامل");
});

test("22) الاختبارات لا تفتح قاعدة التشغيل ولا تتصل بالشبكة", async () => {
  // لم يُنشأ أي .radar-data داخل جذر المشروع (قاعدة التشغيل لم تُفتح).
  assert.ok(!existsSync(path.join(root, ".radar-data")), "لا قاعدة تشغيل داخل worktree");
  // الأدوات نفسها خالية من أي استدعاء شبكة.
  const sourceFiles = [
    "scripts/create-recovery-bundle.mjs",
    "scripts/verify-recovery-bundle.mjs",
    "scripts/lib/recovery-bundle.mjs",
    "scripts/lib/recovery-verify.mjs",
    "scripts/lib/recovery-secrets.mjs",
    "scripts/lib/recovery-state.mjs",
    "scripts/lib/recovery-resume.mjs",
    "scripts/lib/recovery-files.mjs",
  ];
  for (const relative of sourceFiles) {
    const content = await readFile(path.join(root, relative), "utf8");
    assert.doesNotMatch(content, /fetch\(|node:http|node:https|node:net|WebSocket/, `${relative}: لا استدعاء شبكة`);
  }
});
