// مدقق حزمة التعافي المحايدة (واجهة سطر أوامر) — P4-H1A.
// أمر التحقق الواحد:
//   npm run recovery:verify -- "<RECOVERY_BUNDLE_DIR>"
// يعيد exit code صفرًا للحزمة السليمة وغير صفر عند أي فشل.
import path from "node:path";
import { verifyRecoveryBundle } from "./lib/recovery-verify.mjs";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("الاستخدام: node tools/verify-recovery-bundle.mjs \"<RECOVERY_BUNDLE_DIR>\"");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await verifyRecoveryBundle({ bundleDir: path.resolve(target) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // يُطبع stage ورسالة آمنة فقط — لا قيم سرية ولا مسارات شخصية.
    console.log(JSON.stringify({ ok: false, stage: error.stage || "unknown", error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

main();
