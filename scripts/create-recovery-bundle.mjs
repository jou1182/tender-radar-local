// منشئ حزمة التعافي المحايدة (واجهة سطر أوامر) — P4-H1A.
// كل المسارات تُمرَّر صراحة. في هذه المرحلة تُستخدم هذه الأداة مع fixtures
// اصطناعية فقط؛ صناعة حزمة حقيقية من المشروع الرئيسي تحتاج مهمة منفصلة.
// الاستخدام:
//   node scripts/create-recovery-bundle.mjs --project-root "<PROJECT_ROOT>" \
//     --sqlite-path "<SQLITE_PATH>" --output-dir "<RECOVERY_BUNDLE_DIR>" \
//     [--continuity-state <مسار CURRENT_STATE.json>] [--docs-dir <مسار docs/continuity>]
import path from "node:path";
import { createRecoveryBundle } from "./lib/recovery-bundle.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["project-root"] || !args["sqlite-path"] || !args["output-dir"]) {
    console.error("الاستخدام: --project-root <مسار المشروع> --sqlite-path <مسار SQLite> --output-dir <مجلد الإخراج> [--continuity-state <مسار>] [--docs-dir <مسار>]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await createRecoveryBundle({
      projectRoot: path.resolve(args["project-root"]),
      sqlitePath: path.resolve(args["sqlite-path"]),
      outputDir: path.resolve(args["output-dir"]),
      continuityStatePath: args["continuity-state"] ? path.resolve(args["continuity-state"]) : undefined,
      docsDir: args["docs-dir"] ? path.resolve(args["docs-dir"]) : undefined,
    });
    console.log(JSON.stringify({ ok: true, ...result.summary }, null, 2));
  } catch (error) {
    // يُطبع stage ورسالة آمنة فقط — لا قيم سرية ولا مسارات شخصية.
    console.log(JSON.stringify({ ok: false, stage: error.stage || "unknown", error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

main();
