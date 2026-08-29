import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedServiceVersion = "p4a-local-analysis-1";

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

// خروج آمن على ويندوز: process.exit() الفوري بعد عمليات fetch (التي تحمل مؤقّتات
// AbortSignal) يُفجّر تأكيد libuv "UV_HANDLE_CLOSING" أثناء إغلاق المقابض. نؤجل
// الخروج برتكة واحدة كي يُنهي libuv إغلاق مقابضه أولًا. تُستخدم حصرًا عبر
// `return exitSoon(...)` داخل main() كي لا يستمر التنفيذ إلى أسطر الـspawn.
function exitSoon(code) {
  setTimeout(() => process.exit(code), 100);
}

// P5-DASH: يعثر على PID المستمع على منفذ 3000 (netstat) ويتحقق أنه عملية node/vinext تابعة للرادار.
async function findOrphanUiListener() {
  const { execFile } = await import("node:child_process");
  const netstatOutput = await new Promise((resolve) => {
    execFile("netstat.exe", ["-ano"], { timeout: 8_000, maxBuffer: 8_000_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
  for (const line of netstatOutput.split("\n")) {
    if (!/LISTENING\s*$/.test(line.trim()) || !line.includes(":3000 ")) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const tasklistOutput = await new Promise((resolve) => {
      execFile("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 8_000, maxBuffer: 1_000_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
    });
    const processName = tasklistOutput.split(",")[0]?.replace(/"/g, "").trim() ?? "";
    if (/node/i.test(processName)) return { pid, processName };
  }
  return null;
}

async function main() {
  const existingHealth = await readExistingHealth();
  const existingSite = await siteIsOnline();

  if (existingHealth && existingHealth.serviceVersion !== expectedServiceVersion) {
    console.error("توجد خدمة رادار قديمة على المنفذ 4318. أغلق تشغيل الرادار القديم بالكامل ثم شغّل الملف مرة أخرى.");
    return exitSoon(1);
  }
  if (existingHealth && existingSite) {
    console.log("رادار المنافسات يعمل بالفعل بالنسخة الحالية على http://localhost:3000");
    return exitSoon(0);
  }
  if (!existingHealth && existingSite) {
    // P5-DASH: خادم واجهة يتيم — يخدم بناءً قديمًا من الذاكرة ويمنع التشغيل الجديد. نكتشفه ونقتله تلقائيًا.
    const orphan = await findOrphanUiListener();
    if (orphan) {
      console.log(`وُجد خادم واجهة يتيم (PID ${orphan.pid}) يخدم بناءً قديمًا — يتم إيقافه تلقائيًا…`);
      try {
        process.kill(orphan.pid);
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        console.error("تعذر إيقافه تلقائيًا. أغلقه يدويًا ثم أعد المحاولة.");
        return exitSoon(1);
      }
      if (!(await siteIsOnline())) console.log("تم تحرير المنفذ 3000 بنجاح.");
    } else {
      console.error("واجهة قديمة ما زالت تعمل على المنفذ 3000 ولم يتمكن النظام من التعرف عليها. أغلق تشغيل الرادار القديم بالكامل ثم أعد المحاولة.");
      return exitSoon(1);
    }
  }

  const service = existingHealth ? null : spawn(process.execPath, ["scripts/etimad-sync-service.mjs"], { stdio: "inherit" });
  const site = spawn(command, ["run", "start"], { stdio: "inherit", shell: process.platform === "win32" });
  // P5-KEEPALIVE: نبضة إبقاء جلسة اعتماد حيّة — تبدأ مع المنصة وتتوقف معها.
  // تحمي الجلسة من طرد اعتماد بعد الخمول (توفير إعادة إدخال كلمة سر + OTP).
  const keepalive = spawn(process.execPath, ["scripts/lib/session-keepalive.mjs"], { stdio: "inherit" });

  let closing = false;
  function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    service?.kill("SIGTERM");
    site.kill("SIGTERM");
    keepalive.kill("SIGTERM");
    setTimeout(() => process.exit(code), 500);
  }

  service?.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
  site.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
  keepalive.on("exit", (code) => { /* النبضة عملية مساعدة — لا تُسقط المنصة إن خرجت وحدها */ void code; });
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

await main();
