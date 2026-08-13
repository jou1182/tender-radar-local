import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedServiceVersion = "p1-checkpoints-cdp-2";

async function readExistingHealth() {
  try {
    const response = await fetch("http://127.0.0.1:4318/health", { signal: AbortSignal.timeout(1_500) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function siteIsOnline() {
  try {
    const response = await fetch("http://localhost:3000/", { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

const existingHealth = await readExistingHealth();
const existingSite = await siteIsOnline();
if (existingHealth && existingHealth.serviceVersion !== expectedServiceVersion) {
  console.error("توجد خدمة رادار قديمة على المنفذ 4318. أغلق تشغيل الرادار القديم بالكامل ثم شغّل الملف مرة أخرى.");
  process.exit(1);
}
if (existingHealth && existingSite) {
  console.log("رادار المنافسات يعمل بالفعل بالنسخة الحالية على http://localhost:3000");
  process.exit(0);
}
if (!existingHealth && existingSite) {
  console.error("واجهة قديمة ما زالت تعمل على المنفذ 3000. أغلق تشغيل الرادار القديم بالكامل ثم أعد المحاولة.");
  process.exit(1);
}

const service = existingHealth ? null : spawn(process.execPath, ["scripts/etimad-sync-service.mjs"], { stdio: "inherit" });
const site = spawn(command, ["run", "start"], { stdio: "inherit", shell: process.platform === "win32" });

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  service?.kill("SIGTERM");
  site.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

service?.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
site.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
