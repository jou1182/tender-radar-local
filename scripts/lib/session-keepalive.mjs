// P5-KEEPALIVE — نبضة إبقاء جلسة اعتماد حيّة (خيار 1: تمرير + إعادة تحميل صامتة)
// موافقة المالك 2026-08-29: كل دقيقة، مع قفل تشابك — تتوقف النبضة أثناء
// أي مزامنة أو تنزيل حي (يقرأ phase من خدمة الرادار /status).
// لا تنزيل ولا تحليل ولا كتابة بيانات — مجرد نشاط خفيف في صفحة اعتماد.
const CDP_PORT = Number(process.env.RADAR_LIVE_CDP_PORT ?? 9333);
const SERVICE_URL = process.env.RADAR_SERVICE_URL ?? "http://127.0.0.1:4318";
const DEFAULT_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS ?? 60_000); // fallback إن تعذر الوصول للخدمة

export const DEFAULT_MIN_INTERVAL_SEC = 60;   // دقيقة واحدة (60 ثانية)
export const DEFAULT_MAX_INTERVAL_SEC = 300;  // 5 دقائق (300 ثانية)

// دالة نقية قابلة للاختبار لاختيار فاصل عشوائي بالثواني بين min و max (غير ثابت)
export function computeVariableIntervalSeconds({
  minSeconds = DEFAULT_MIN_INTERVAL_SEC,
  maxSeconds = DEFAULT_MAX_INTERVAL_SEC,
  stepSeconds = 15,
  random = Math.random,
} = {}) {
  const safeMin = Math.max(30, Math.min(minSeconds, maxSeconds));
  const safeMax = Math.min(300, Math.max(minSeconds, maxSeconds));
  if (safeMin === safeMax) return safeMin;
  const steps = Math.floor((safeMax - safeMin) / stepSeconds);
  if (steps <= 0) return safeMin;
  const chosenStep = Math.floor(random() * (steps + 1));
  const result = safeMin + chosenStep * stepSeconds;
  return Math.max(safeMin, Math.min(safeMax, result));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// حساب فترة النبضة التالية: متغيرة عشوائيًا بحدود 5 دقائق (60 إلى 300 ثانية)
export async function currentIntervalMs() {
  if (process.env.KEEPALIVE_INTERVAL_MS) {
    const forced = Number(process.env.KEEPALIVE_INTERVAL_MS);
    if (Number.isFinite(forced) && forced > 0) return forced;
  }
  let minSec = DEFAULT_MIN_INTERVAL_SEC;
  let maxSec = DEFAULT_MAX_INTERVAL_SEC;
  try {
    const res = await fetch(`${SERVICE_URL}/keepalive/interval`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      const data = await res.json();
      const configuredSec = Number(data?.keepaliveIntervalSeconds);
      if (Number.isFinite(configuredSec) && configuredSec > DEFAULT_MIN_INTERVAL_SEC) {
        maxSec = Math.min(300, Math.round(configuredSec));
      }
    }
  } catch {
    // fallback في حال تعذر الاتصال بالخدمة: استخدام المدى الافتراضي [60, 300]
  }
  const chosenSeconds = computeVariableIntervalSeconds({ minSeconds: minSec, maxSeconds: maxSec });
  return chosenSeconds * 1000;
}

// فحص قفل التشابك: هل الخدمة في مزامنة/تنزيل نشط؟
const busyPhases = new Set(["starting", "scanning", "resuming", "captcha-required", "login-required"]);

export function isBusyPhase(phase) {
  return busyPhases.has(String(phase ?? ""));
}

// P5-KEEPALIVE: الانشغال = مزامنة نشطة أو تنزيل حي جارٍ.
export function isServiceBusy(status) {
  return isBusyPhase(status?.phase) || status?.downloading === true;
}

async function serviceBusy() {
  try {
    const res = await fetch(`${SERVICE_URL}/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    return isServiceBusy(await res.json());
  } catch {
    return false; // إن تعذر الوصول للخدمة، نفترض عدم انشغال (النبضة لا تؤذي)
  }
}

// إيجاد صفحة اعتماد في جلسة Chrome البشرية
async function findEtimadTarget() {
  try {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
    const page = targets.find((t) => t.type === "page" && (t.url ?? "").includes("etimad.sa"))
      ?? targets.find((t) => t.type === "page");
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null; // Chrome غير مفتوح بعد — نعود null بلا انهيار
  }
}

let msgId = 0;
function makeCdp(ws) {
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 6_000);
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function pulse() {
  if (await serviceBusy()) {
    console.log(`[${new Date().toISOString()}] ⏭ تخطّي: خدمة الرادار منشغلة (مزامنة/تنزيل حي)`);
    return "busy";
  }
  const wsUrl = await findEtimadTarget();
  if (!wsUrl) {
    console.log(`[${new Date().toISOString()}] ⚠ لا توجد صفحة اعتماد مفتوحة في جلسة Chrome`);
    return "no-target";
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect")); });
  try {
    const cdp = makeCdp(ws);
    // تمرير خفيف لأسفل ثم لأعلى (نشاط DOM)
    await cdp("Runtime.evaluate", {
      expression: "window.scrollBy(0, 120); setTimeout(() => window.scrollBy(0, -120), 400); 'scrolled'",
      returnByValue: true,
    });
    // إعادة تحميل صامتة للصفحة الحالية (نشاط على مستوى الخادم)
    await cdp("Page.reload", { ignoreCache: true });
    console.log(`[${new Date().toISOString()}] ♥ نبضة: تمرير + إعادة تحميل لصفحة اعتماد`);
    return "pulsed";
  } catch (error) {
    console.log(`[${new Date().toISOString()}] ✖ خطأ النبضة: ${error.message}`);
    return "error";
  } finally {
    try { ws.close(); } catch {}
  }
}

console.log(`نبضة إبقاء جلسة اعتماد — فواصل متغيرة (بين دقيقة و5 دقائق)، CDP:${CDP_PORT}، قفل تشابك عبر ${SERVICE_URL}/status`);
// لا نبدأ الحلقة عند الاستيراد (للاختبار) — فقط عند التشغيل المباشر.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  // حلقة ذاتية ذكية:
  // - بعد نبضة ناجحة: فاصل زمني متغير عشوائيًا (بين دقيقة و5 دقائق) لمحاكاة السلوك البشري ومنع كشف الروبوت.
  // - عند انشغال الخدمة: انتظار قصير (30ث) ثم التحقق مجددًا لتجنب فجوات خمول مفرطة بعد انتهاء التنزيل/المزامنة.
  // - عند عدم فتح المتصفح: فحص سريع كل 15 ثانية لالتقاط الجلسة فور إقلاع Chrome.
  for (;;) {
    const outcome = await pulse();
    let waitMs;
    if (outcome === "no-target") {
      waitMs = 15_000;
    } else if (outcome === "busy") {
      waitMs = 30_000;
    } else {
      waitMs = await currentIntervalMs();
      const waitSec = Math.round(waitMs / 1000);
      const waitMin = (waitSec / 60).toFixed(1);
      console.log(`[${new Date().toISOString()}] ⏳ النبضة التالية بعد ${waitSec} ثانية (~${waitMin} دقيقة)`);
    }
    await sleep(waitMs);
  }
}
