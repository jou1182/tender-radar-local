// قراءات الحالة الفعلية لحزمة التعافي — P4-H1A.
// Hash Git يُقرأ من المستودع المصدر، وschemaVersion وأعداد السجلات تُقرأ من
// نسخة SQLite، والمرحلة تُقرأ من وثائق continuity المنظمة — لا نص ثابت هنا.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export class RecoveryStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryStateError";
    this.code = "recovery-state";
    Object.assign(this, details);
  }
}

export function gitOut(projectRoot, args) {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new RecoveryStateError(`فشل أمر git ${args[0]} داخل المستودع المصدر`, { stage: "git", cause: error.message });
  }
}

// يقرأ رأس main وحالة شجرة العمل من المستودع المصدر قراءةً فقط.
export function readGitState(projectRoot) {
  const inside = gitOut(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new RecoveryStateError("المسار الممرر ليس مستودع Git", { stage: "git" });
  }
  const mainCommit = gitOut(projectRoot, ["rev-parse", "--verify", "refs/heads/main"]);
  if (!/^[0-9a-f]{40}$/.test(mainCommit)) {
    throw new RecoveryStateError("تعذر قراءة رأس refs/heads/main من المستودع المصدر", { stage: "git" });
  }
  const status = gitOut(projectRoot, ["status", "--porcelain"]);
  const entries = status ? status.split("\n").length : 0;
  return { mainCommit, clean: entries === 0, statusEntries: entries };
}

// يقرأ schemaVersion وأعداد الجداول والسجلات من ملف SQLite معطى (نسخة أو أصلًا)
// باتصال قراءة فقط. تتطلب جدول schema_migrations كما في مخطط المشروع.
export function readSqliteState(sqlitePath) {
  let database;
  try {
    database = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch (error) {
    throw new RecoveryStateError("تعذر فتح ملف SQLite للقراءة فقط", { stage: "sqlite", cause: error.message });
  }
  try {
    const versionRow = database.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    const tables = {};
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    for (const { name } of names) {
      const escaped = String(name).replaceAll('"', '""');
      tables[name] = database.prepare(`SELECT COUNT(*) AS c FROM "${escaped}"`).get().c;
    }
    return { schemaVersion: versionRow && versionRow.v != null ? Number(versionRow.v) : null, tables };
  } catch (error) {
    throw new RecoveryStateError("تعذر قراءة schemaVersion أو أعداد السجلات من SQLite", { stage: "sqlite", cause: error.message });
  } finally {
    database.close();
  }
}

// PRAGMA quick_check على ملف SQLite باتصال قراءة فقط. يعيد "ok" أو نص الخلل.
export function quickCheckSqlite(sqlitePath) {
  let database;
  try {
    database = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch (error) {
    throw new RecoveryStateError("تعذر فتح ملف SQLite لفحص quick_check", { stage: "sqlite", cause: error.message });
  }
  try {
    const row = database.prepare("PRAGMA quick_check").get();
    return row ? String(row.quick_check) : "no-result";
  } finally {
    database.close();
  }
}

// يسرد أسماء الجداول والأعمدة (لبوابة الأسرار) دون قراءة أي بيانات صفوف.
export function listSqliteIdentifiers(sqlitePath) {
  let database;
  try {
    database = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch (error) {
    throw new RecoveryStateError("تعذر فتح ملف SQLite لسرد المعرفات", { stage: "sqlite", cause: error.message });
  }
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const columns = [];
    for (const table of tables) {
      const escaped = table.replaceAll('"', '""');
      for (const column of database.prepare(`PRAGMA table_info("${escaped}")`).all()) {
        columns.push(`${table}.${column.name}`);
      }
    }
    return { tables, columns };
  } finally {
    database.close();
  }
}

// يقرأ حالة continuity المنظمة (CURRENT_STATE.json أو fixture مكافئة) ويتحقق
// من الحد الأدنى من البنية الذي يعتمد عليه توليد RESUME_HERE.
export async function readContinuityState(continuityStatePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(continuityStatePath, "utf8"));
  } catch (error) {
    throw new RecoveryStateError("تعذر قراءة وثيقة حالة continuity المنظمة", { stage: "continuity-state", cause: error.message });
  }
  const requiredStrings = ["stateSchemaVersion", "projectName", "lastApprovedFunctionalPhase", "continuityPackagePhase", "nextPlannedPhase"];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      throw new RecoveryStateError(`وثيقة حالة continuity تفتقد الحقل النصي ${key}`, { stage: "continuity-state" });
    }
  }
  if (typeof parsed.databaseSchemaVersion !== "number") {
    throw new RecoveryStateError("وثيقة حالة continuity تفتقد databaseSchemaVersion الرقمية", { stage: "continuity-state" });
  }
  if (!parsed.testBaselines || typeof parsed.testBaselines !== "object") {
    throw new RecoveryStateError("وثيقة حالة continuity تفتقد testBaselines", { stage: "continuity-state" });
  }
  if (!parsed.attachmentLiveStages || typeof parsed.attachmentLiveStages !== "object") {
    throw new RecoveryStateError("وثيقة حالة continuity تفتقد attachmentLiveStages", { stage: "continuity-state" });
  }
  if (!Array.isArray(parsed.pendingHumanGates)) {
    throw new RecoveryStateError("وثيقة حالة continuity تفتقد pendingHumanGates", { stage: "continuity-state" });
  }
  return parsed;
}
