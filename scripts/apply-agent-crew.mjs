// P5-AGENTS-READY — تطبيق تعريف الطاقم (ربط محلي + تعليمات سلوك) على قاعدة محدَّدة صراحة.
//
// الاستخدام:
//   node scripts/apply-agent-crew.mjs --db-root "<مسار المستودع الحاوي لـ.radar-data>"            # معاينة (افتراضي)
//   node scripts/apply-agent-crew.mjs --db-root "<المسار>" --apply                                 # تنفيذ فعلي
//   node scripts/apply-agent-crew.mjs --db-root "<المسار>" --apply --only scout,analyst           # أدوار محددة
//
// ضمانات السلامة (كلها مختبَرة في tests/agent-crew.test.mjs):
// 1) --db-root إلزامي: لا تلميح من مجلد التشغيل الحالي (خلل السكربت القديم seed-agent-bindings.mjs
//    الذي استخدم path.resolve(".") فيكتب في قاعدة أخرى بصمت).
// 2) المعاينة افتراضية — لا كتابة إلا بـ--apply.
// 3) يكتب الربط والتعليمات فقط: لا يمس الاسم العربي/الإنجليزي ولا enabled ولا display_order.
// 4) يرفض أي تعريف يخالف الحوكمة (نموذج خارجي، تعليمات > 8000 حرف، فراغ) قبل أي كتابة.
// 5) idempotent: إعادة التطبيق لا تحدث فرقًا، ويُبلَّغ بذلك.
// 6) يسجّل نشاطًا (crew-applied) لكل وكيل تغيّر فعلًا — قابل للتدقيق في /agents.
import path from "node:path";
import { stat } from "node:fs/promises";
import { createRadarRepository } from "./lib/radar-repository.mjs";
import { validateBinding } from "./lib/agent-team.mjs";
import { agentCrew, validateCrew, crewInstructionLimit } from "./lib/agent-crew-p5ready.mjs";

const OLLAMA_URL = "http://127.0.0.1:11434";
const DB_RELATIVE = path.join(".radar-data", "radar.sqlite");

function parseArgs(argv) {
  const args = { dbRoot: undefined, apply: false, only: undefined, allowEmptyDb: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--db-root") { i += 1; args.dbRoot = argv[i]; continue; }
    if (token.startsWith("--db-root=")) { args.dbRoot = token.slice("--db-root=".length); continue; }
    if (token === "--apply") { args.apply = true; continue; }
    if (token === "--only") { i += 1; args.only = argv[i]; continue; }
    if (token.startsWith("--only=")) { args.only = token.slice("--only=".length); continue; }
    if (token === "--allow-empty-db") { args.allowEmptyDb = true; continue; }
    const error = new Error(`معامل غير معروف: ${token}`);
    error.code = "UNKNOWN_ARGUMENT";
    throw error;
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

  // P5-AGENTS-READY (ملاحظة المراجعة S1): بوابة هوية الهدف. وجود .radar-data وحده
  // لا يكفي — هناك مجلدات شقيقة كثيرة في الشجرة، وخطأ مسار واحد كان سيطبّق الطاقم
  // على قاعدة خاطئة بصمت. فتُشترط قاعدة موجودة فعلًا، ولا يُقبل هدف فارغ إلا بعلم صريح.
  const dbPath = path.join(projectRoot, DB_RELATIVE);
  let dbStat;
  try {
    dbStat = await stat(dbPath);
  } catch {
    if (!args.allowEmptyDb) {
      console.error(`لا توجد قاعدة في: ${dbPath}\nالهدف غير مؤكَّد الهوية — أُوقف بلا كتابة. إن كان هدفًا جديدًا فعلًا فمرّر --allow-empty-db صراحةً.`);
      process.exitCode = 2;
      return;
    }
  }
  console.log(`الهدف: ${projectRoot}`);
  console.log(`القاعدة: ${dbPath}${dbStat ? ` (${dbStat.size} بايت، آخر تعديل ${dbStat.mtime.toISOString()})` : " (غير موجودة — هدف جديد بعلم صريح)"}`);

  const problems = validateCrew(agentCrew);
  if (problems.length) {
    console.error("تعريف الطاقم مخالف للحوكمة — أُوقف بلا أي كتابة:");
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exitCode = 3;
    return;
  }

  const repository = await createRadarRepository({ projectRoot });
  const roles = selectRoles(agentCrew, args.only);
  const unknown = roles.filter((role) => !agentCrew[role]);
  if (unknown.length) {
    console.error(`أدوار غير معروفة في تعريف الطاقم: ${unknown.join(", ")}`);
    process.exitCode = 3;
    return;
  }

  console.log(`الوضع: ${args.apply ? "تنفيذ فعلي (--apply)" : "معاينة فقط (بلا كتابة)"}\n`);

  let changed = 0;
  for (const role of roles) {
    const agent = repository.getAgentByRole(role);
    if (!agent) { console.error(`  ✖ ${role}: غير موجود في القاعدة`); process.exitCode = 3; continue; }
    const binding = validateBinding({ provider: "ollama", baseUrl: OLLAMA_URL, model: agentCrew[role].model });
    const nextInstructions = agentCrew[role].instructions;
    const bindingSame = JSON.stringify(agent.binding) === JSON.stringify(binding);
    const instructionsSame = String(agent.system_instructions) === nextInstructions;
    if (bindingSame && instructionsSame) {
      console.log(`  = ${role} (${agent.name_ar}): مطابق بالفعل — لا تغيير`);
      continue;
    }
    changed += 1;
    console.log(`  ● ${role} (${agent.name_ar})`);
    console.log(`      الربط:  ${summarize(agent.binding)}  →  ${summarize(binding)}`);
    console.log(`      التدريب: ${String(agent.system_instructions).length} حرفًا  →  ${nextInstructions.length} حرفًا (الحد ${crewInstructionLimit})`);
    if (args.apply) {
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
  if (!args.apply) {
    console.log(`معاينة: ${changed} وكيلًا سيتغيّر. لم تُكتب أي بيانات. أعد التنفيذ بـ--apply للتطبيق.`);
    return;
  }
  console.log(`تم التطبيق: ${changed} وكيلًا تغيّر (الربط + التعليمات فقط؛ الأسماء والحالة والترتيب لم تُمس).`);
}

await main();
