// اختبارات P4-O0B — checkpoint تلقائي للـWAL عند اكتمال الجولة
// ملاحظة حاكمة: SQLite يحذف ملف -wal عند إغلاق آخر اتصال نظيف؛ لذلك تُبقي الاختبارات
// اتصالًا مفتوحًا أثناء الفحص — وهو نفسه وضع خدمة المزامنة الحقيقي أثناء التشغيل.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  maybeTruncateWal,
  truncateSourceWalAfterCompleteRun,
} from "../scripts/lib/db-maintenance.mjs";

async function makeOpenWalDatabase(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, "radar.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (x TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("قيمة");
  const walPath = `${dbPath}-wal`;
  return { dir, dbPath, walPath, db };
}

test("P4-O0B-1: wal file exists while a connection stays open", async () => {
  const { dir, walPath, db } = await makeOpenWalDatabase("radar-o0b-pre-");
  try {
    assert.ok(existsSync(walPath), "wal should exist while the connection is open");
    assert.ok((await stat(walPath)).size > 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("P4-O0B-2: maybeTruncateWal truncates an oversized wal to zero", async () => {
  const { dir, dbPath, walPath, db } = await makeOpenWalDatabase("radar-o0b-trunc-");
  try {
    // بذور كافية لتجاوز عتبة 64KB قبل التنفيذ
    for (let i = 0; i < 400; i += 1) db.prepare("INSERT INTO t VALUES (?)").run(`صف-${i}`);
    const sizeBefore = (await stat(walPath)).size;
    assert.ok(sizeBefore >= 64 * 1024);
    const result = await maybeTruncateWal(dbPath);
    assert.equal(result.attempted, true);
    assert.ok(existsSync(walPath), "wal file must remain (TRUNCATE, never delete)");
    assert.equal((await stat(walPath)).size, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("P4-O0B-3: maybeTruncateWal skips when wal is absent or below the threshold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "radar-o0b-skip-"));
  try {
    const missing = path.join(dir, "no-wal.sqlite");
    const skippedMissing = await maybeTruncateWal(missing);
    assert.equal(skippedMissing.attempted, false);
    assert.equal(skippedMissing.skipped, true);

    const { dbPath, db } = await makeOpenWalDatabase("radar-o0b-tiny-");
    try {
      const result = await maybeTruncateWal(dbPath);
      assert.equal(result.attempted, false);
      assert.equal(result.skipped, true);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P4-O0B-4: complete-run wrapper only acts on status complete", async () => {
  const { dir, dbPath, walPath, db } = await makeOpenWalDatabase("radar-o0b-run-");
  try {
    for (let i = 0; i < 400; i += 1) db.prepare("INSERT INTO t VALUES (?)").run(`صف-${i}`);
    const partial = await truncateSourceWalAfterCompleteRun({ databasePath: dbPath, runStatus: "partial" });
    assert.equal(partial.attempted, false);
    const complete = await truncateSourceWalAfterCompleteRun({ databasePath: dbPath, runStatus: "complete" });
    assert.equal(complete.attempted, true);
    assert.equal((await stat(walPath)).size, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
