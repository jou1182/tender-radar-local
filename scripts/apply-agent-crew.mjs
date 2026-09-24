// P5-AGENTS-READY — تطبيق تعريف الطاقم (ربط محلي + تعليمات) على قاعدة محدَّدة صراحة.
//
//   node scripts/apply-agent-crew.mjs --db-root "<مسار المستودع الحاوي .radar-data>"            ← معاينة (افتراضي)
//   node scripts/apply-agent-crew.mjs --db-root "<مسار>" --apply                                  ← تنفيذ
//   node scripts/apply-agent-crew.mjs --db-root "<مسار>" --only scout,analyst                     ← حصر أدوار
//
// ضمانات مقصودة (كلها مختبَرة في tests/agent-crew.test.mjs):
//   • --db-root إلزامي: لا مسار ضمني ولا أثر لمجلد التشغيل الحالي.
//   • المعاينة **للقراءة فقط**: تفتح القاعدة readOnly ولا تنشئ ملفًا ولا تكتب سطرًا.
//   • بوابة هوية الهدف (S1): قاعدة خالية من بيانات التشغيل تُرفض إلا بعلم --allow-empty-db.
//   • تلمس الربط والتعليمات فقط — الأسماء والحالة والترتيب لا تُمَس (مُثبَت باختبار).
//   • idempotent + سطر تدقيق per وكيل في سجل النشاط (crew-applied).

import path from "node:path";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRadarRepository } from "./lib/radar-repository.mjs";
import { validateBinding } from "./lib/agent-team.mjs";
import { OLLAMA_URL, agentCrew, classifyTarget, crewInstructionLimit, validateCrew } from "./lib/agent-crew-p5ready.mjs";

const DB_RELATIVE = path.join(".radar-data", "radar.sqlite");

function parseArgs(argv) {
  const args = { apply: false, only: null, dbRoot: null, allowEmptyDb: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") args.apply = true;
    else if (token === "--allow-empty-db") args.allowEmptyDb = true;
    else if (token === "--db-root") args.dbRoot = argv[++i];
    else if (token.startsWith("--db-root=")) args.dbRoot = token.slice("--db-root=".length);
    else if (token === "--only") args.only = argv[++i];
    else if (token.startsWith("--only=")) args.only = token.slice("--only=".length);
    else throw new Error(`معامل غير معروف: ${token}`);
  }
  return args;
}

function selectRoles(crew, only) {
  if (!only) return Object.keys(crew);
  return String(only).split(",").map((r) => r.trim()).filter(Boolean);
}

function summarize(binding) {
  const provider = String(binding?.provider || "?");
  const model = binding?.model ? `:${binding.model}` : "";
  const url = binding?.baseUrl ? ` @${binding.baseUrl}` : "";
  return `${provider}${model}${url}`;
}

function readCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const one = (sql) => {
      try {
        return Number(db.prepare(sql).get()?.n ?? 0);
      } catch {
        return 0;
      }
    };
    return {
      tenders: one("SELECT COUNT(*) AS n FROM tenders"),
      syncRuns: one("SELECT COUNT(*) AS n FROM sync_runs"),
      agents: one("SELECT COUNT(*) AS n FROM agents"),
    };
  } finally {
    db.close();
  }
}

function readAgentReadOnly(dbPath, role) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT role_code, name_ar, binding_json, system_instructions FROM agents WHERE role_code = ?")
      .get(role);
    if (!row) return null;
    let binding = null;
    try {
      binding = JSON.parse(String(row.binding_json || "null"));
    } catch {
      binding = null;
    }
    return { roleCode: row.role_code, nameAr: row.name_ar, binding, system_instructions: String(row.system_instructions ?? "") };
  } finally {
    db.close();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 2;
    return;
  }
  if (!args.dbRoot) {
    console.error("مطلوب --db-root صراحةً (المسار الحاوي لـ.radar-data). لا كتابة بأثر مجلد التشغيل الحالي.");
    process.exitCode = 2;
    return;
  }
  const projectRoot = path.resolve(args.dbRoot);
  try {
    await stat(path.join(projectRoot, ".radar-data"));
  } catch {
    console.error(`لا يوجد .radar-data داخل: ${projectRoot} — تحقق من المسار قبل أي كتابة.`);
    process.exitCode = 2;
    return;
  }

  const dbPath = path.join(projectRoot, DB_RELATIVE);
  let dbStat = null;
  try {
    dbStat = await stat(dbPath);
  } catch {
    dbStat = null;
  }

  const counts = dbStat ? readCounts(dbPath) : { tenders: 0, syncRuns: 0, agents: 0 };
  const target = classifyTarget({
    dbExists: Boolean(dbStat),
    allowEmptyDb: args.allowEmptyDb,
    tenders: counts.tenders,
    syncRuns: counts.syncRuns,
  });
  if (!target.ok) {
    console.error(`${target.message}\nالهدف المفحوص: ${dbPath}`);
    process.exitCode = 2;
    return;
  }

  console.log(`الهدف: ${projectRoot}`);
  console.log(
    `القاعدة: ${dbPath}` +
      (dbStat
        ? ` (${dbStat.size} بايت، آخر تعديل ${dbStat.mtime.toISOString()})`
        : " (غير موجودة — هدف جديد بعلم صريح)"),
  );
  if (dbStat) console.log(`محتوى الهدف: ${counts.agents} وكيلًا · ${counts.tenders} منافسة · ${counts.syncRuns} مزامنة — ${target.reason}`);
  else console.log(`الهدف: ${target.reason}`);

  const problems = validateCrew(agentCrew);
  if (problems.length) {
    console.error("تعريف الطاقم مخالف للحوكمة — أُوقف بلا أي كتابة:");
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exitCode = 3;
    return;
  }

  const roles = selectRoles(agentCrew, args.only);
  const unknown = roles.filter((role) => !agentCrew[role]);
  if (unknown.length) {
    console.error(`أدوار غير معروفة في تعريف الطاقم: ${unknown.join(", ")}`);
    process.exitCode = 3;
    return;
  }

  console.log(`الوضع: ${args.apply ? "تنفيذ فعلي (--apply)" : "معاينة فقط (قراءة فقط، بلا أي كتابة)"}\n`);

  // هدف جديد في وضع المعاينة: لا قاعدة للقراءة، ولا ننشئ واحدة (المعاينة بلا آثار).
  if (!args.apply && !dbStat) {
    console.log(`هدف جديد: لا قاعدة قائمة للمقارنة. عند التنفيذ بـ--apply ستُنشأ القاعدة ويُطبَّق الطاقم (${roles.length} أدوار).`);
    console.log("\nمعاينة: لا تغييرات قابلة للمقارنة (هدف جديد). لم تُكتب أي بيانات ولم يُنشأ أي ملف.");
    return;
  }

  // لا يُفتح المستودع الكتابي إلا عند التنفيذ الفعلي — المعاينة لا تنشئ قاعدة ولا تكتب.
  const repository = args.apply ? await createRadarRepository({ projectRoot }) : null;
  const read = (role) => (repository ? repository.getAgentByRole(role) : readAgentReadOnly(dbPath, role));

  let changed = 0;
  for (const role of roles) {
    const agent = read(role);
    if (!agent) {
      console.error(`  ✖ ${role}: غير موجود في القاعدة`);
      process.exitCode = 3;
      continue;
    }
    const binding = validateBinding({ provider: "ollama", baseUrl: OLLAMA_URL, model: agentCrew[role].model });
    const nextInstructions = agentCrew[role].instructions;
    const bindingSame = JSON.stringify(agent.binding) === JSON.stringify(binding);
    const instructionsSame = String(agent.system_instructions) === nextInstructions;
    if (bindingSame && instructionsSame) {
      console.log(`  = ${role} (${agent.name_ar ?? agent.nameAr}): مطابق بالفعل — لا تغيير`);
      continue;
    }
    changed += 1;
    console.log(`  ● ${role} (${agent.name_ar ?? agent.nameAr})`);
    console.log(`      الربط:  ${summarize(agent.binding)}  →  ${summarize(binding)}`);
    console.log(
      `      التدريب: ${String(agent.system_instructions).length} حرفًا  →  ${nextInstructions.length} حرفًا (الحد ${crewInstructionLimit})`,
    );
    if (repository) {
      repository.setAgentBinding(role, binding);
      repository.setAgentInstructions(role, nextInstructions);
      repository.recordAgentActivity({
        roleCode: role,
        action: "crew-applied",
        status: "success",
        detail: { model: agentCrew[role].model, provider: "ollama", instructionsChars: nextInstructions.length },
      });
    }
  }

  console.log("");
  if (!repository) {
    console.log(`معاينة: ${changed} وكيلًا سيتغيّر. لم تُكتب أي بيانات. أعد التنفيذ بـ--apply للتطبيق.`);
    return;
  }
  console.log(`تم التطبيق: ${changed} وكيلًا تغيّر (الربط + التعليمات فقط؛ الأسماء والحالة والترتيب لم تُمس).`);
}

await main();
