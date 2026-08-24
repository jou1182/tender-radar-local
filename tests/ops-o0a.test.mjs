// اختبارات P4-O0A — أدوات النسخ الاحتياطي الآمن وفحص الصحة
// كل الاختبارات على قواعد معزولة في مجلدات عابرة؛ قاعدة التشغيل لا تُلمس إطلاقًا.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createDatabaseBackup } from "../scripts/lib/db-maintenance.mjs";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// خادم مغلق مؤقت لاختبار فشل الصحة دون افتراض حالة خدمات الجهاز الحقيقية.
let closedServer = null;
async function startClosedServer() {
  closedServer = http.createServer((_request, response) => response.destroy());
  await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
  const port = closedServer.address().port;
  return {
    RADAR_UI_URL: `http://127.0.0.1:${port}/`,
    RADAR_SYNC_URL: `http://127.0.0.1:${port}/health`,
  };
}
async function stopClosedServer() {
  if (!closedServer) return;
  await new Promise((resolve) => closedServer.close(resolve));
  closedServer = null;
}

function runCli(args, envOverrides = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: worktreeRoot, env: { ...process.env, ...envOverrides }, timeout: 30000 },
      (error, stdout) => {
        resolve({ code: error?.code ?? 0, stdout: String(stdout || "") });
      },
    );
  });
}

async function makeIsolatedProjectRoot(prefix) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(projectRoot, ".radar-data");
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "radar.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE tenders (reference TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO tenders VALUES (?, ?)").run("260739009419", "منافسة اختبار");
  db.close();
  return { projectRoot, dataDir, dbPath };
}

test("P4-O0A-1: backup creates an integrity-checked copy containing the source tables and rows", async () => {
  const { projectRoot, dataDir } = await makeIsolatedProjectRoot("radar-o0a-backup-");
  try {
    const targetPath = path.join(dataDir, "manual-copy.sqlite");
    const result = await createDatabaseBackup({ projectRoot, targetPath });
    assert.equal(result.integrity, "ok");
    assert.ok(result.bytes > 0);
    assert.ok(result.tableCount >= 1);
    const copy = new DatabaseSync(targetPath, { readOnly: true });
    try {
      const row = copy.prepare("SELECT title FROM tenders WHERE reference = ?").get("260739009419");
      assert.equal(row.title, "منافسة اختبار");
    } finally {
      copy.close();
    }
    assert.equal(result.walCheckpointAfterCopy.ok, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-2: backup refuses to overwrite an existing target with BACKUP_TARGET_EXISTS", async () => {
  const { projectRoot, dataDir } = await makeIsolatedProjectRoot("radar-o0a-exists-");
  try {
    const targetPath = path.join(dataDir, "existing.sqlite");
    await createDatabaseBackup({ projectRoot, targetPath });
    await assert.rejects(
      () => createDatabaseBackup({ projectRoot, targetPath }),
      (error) => error.code === "BACKUP_TARGET_EXISTS",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-3: backup may target a directory outside the project root (per OPERATIONS_RUNBOOK)", async () => {
  const { projectRoot } = await makeIsolatedProjectRoot("radar-o0a-outside-");
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "radar-o0a-outside-target-"));
  try {
    const result = await createDatabaseBackup({
      projectRoot,
      targetPath: path.join(outsideDir, "copy.sqlite"),
    });
    assert.equal(result.integrity, "ok");
    assert.ok(existsSync(path.join(outsideDir, "copy.sqlite")));
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-3b: backup refuses to target the live database or its wal/shm sidecars", async () => {
  const { projectRoot, dbPath } = await makeIsolatedProjectRoot("radar-o0a-livedb-");
  try {
    for (const targetPath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      await assert.rejects(
        () => createDatabaseBackup({ projectRoot, targetPath }),
        (error) => error.code === "BACKUP_TARGET_IS_LIVE_DATABASE",
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-4: wal checkpoint truncates the source wal after a write", async () => {
  const { projectRoot, dataDir, dbPath } = await makeIsolatedProjectRoot("radar-o0a-wal-");
  try {
    // كتابة جديدة عبر اتصال ثانٍ تضخّم الـWAL ثم تُغلق الكتابة مع بقائه غير مختصر.
    const writer = new DatabaseSync(dbPath);
    writer.prepare("INSERT INTO tenders VALUES (?, ?)").run("260839002206", "منافسة ثانية");
    writer.close();
    const walPath = `${dbPath}-wal`;
    const sizeBefore =
      existsSync(walPath) ? (await import("node:fs")).statSync(walPath).size : 0;

    const targetPath = path.join(dataDir, "after-wal.sqlite");
    const result = await createDatabaseBackup({ projectRoot, targetPath });
    assert.equal(result.walCheckpointAfterCopy.ok, true);
    const sizeAfter = existsSync(walPath)
      ? (await import("node:fs")).statSync(walPath).size
      : 0;
    if (sizeBefore > 0) {
      assert.ok(sizeAfter < sizeBefore, `wal should shrink: ${sizeBefore} -> ${sizeAfter}`);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-5: cli writes a timestamped backup into the default backups directory", async () => {
  const { projectRoot } = await makeIsolatedProjectRoot("radar-o0a-cli-default-");
  try {
    const outcome = await runCli(["scripts/db-backup.mjs"], { RADAR_DB_ROOT: projectRoot });
    assert.equal(outcome.code, 0, outcome.stdout);
    const payload = JSON.parse(outcome.stdout);
    assert.equal(payload.ok, true);
    assert.match(path.basename(payload.backup), /^radar-backup-\d{8}T\d{6}Z\.sqlite$/);
    const backupDir = path.join(projectRoot, ".radar-data", "backups");
    const files = await readdir(backupDir);
    assert.equal(files.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-6: health check fails with non-zero exit when services are unreachable", async () => {
  // معزولة عن البيئة: خادم مؤقت يغلق اتصاله فورًا (connection refused) على منفذ عابر
  // بدل افتراض توقف خدمات الجهاز — قد يكون الرادار الحقيقي يعمل فعلًا أثناء الاختبار.
  const { RADAR_UI_URL, RADAR_SYNC_URL } = await startClosedServer();
  try {
    const outcome = await runCli(["scripts/health-check.mjs"], {
      RADAR_UI_URL,
      RADAR_SYNC_URL,
    });
    assert.notEqual(outcome.code, 0);
    const payload = JSON.parse(outcome.stdout);
    assert.equal(payload.ok, false);
    for (const key of ["ui", "syncService", "analysisHealth"]) {
      assert.equal(payload.checks[key].ok, false);
    }
  } finally {
    await stopClosedServer();
  }
});

test("P4-O0A-7: cli writes into an explicit --out directory when given", async () => {
  const { projectRoot } = await makeIsolatedProjectRoot("radar-o0a-cli-dir-");
  try {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "radar-o0a-outdir-"));
    try {
      const outcome = await runCli(
        ["scripts/db-backup.mjs", "--out", outDir],
        { RADAR_DB_ROOT: projectRoot },
      );
      assert.equal(outcome.code, 0, outcome.stdout);
      const payload = JSON.parse(outcome.stdout);
      assert.equal(payload.ok, true);
      assert.ok(payload.backup.startsWith(outDir));
      assert.match(path.basename(payload.backup), /^radar-backup-\d{8}T\d{6}Z\.sqlite$/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P4-O0A-8: package.json exposes db:backup and health scripts", async () => {
  const pkgText = await readFile(path.join(worktreeRoot, "package.json"), "utf8");
  assert.ok(pkgText.includes('"db:backup": "node scripts/db-backup.mjs"'));
  assert.ok(pkgText.includes('"health": "node scripts/health-check.mjs"'));
});
