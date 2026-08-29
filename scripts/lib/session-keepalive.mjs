// P5-KEEPALIVE — نبضة إبقاء جلسة اعتماد حيّة (خيار 1: تمرير + إعادة تحميل صامتة)
// موافقة المالك 2026-08-29: كل دقيقة، مع قفل تشابك — تتوقف النبضة أثناء
// أي مزامنة أو تنزيل حي (يقرأ phase من خدمة الرادار /status).
// لا تنزيل ولا تحليل ولا كتابة بيانات — مجرد نشاط خفيف في صفحة اعتماد.
const CDP_PORT = Number(process.env.RADAR_LIVE_CDP_PORT ?? 9333);
const SERVICE_URL = process.env.RADAR_SERVICE_URL ?? "http://127.0.0.1:4318";
const DEFAULT_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS ?? 60_000); // fallback إن تعذر الوصول للخدمة

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// قراءة فترة النبضة الحالية من الخدمة (قابلة للتعديل من لوحة القيادة).
async function currentIntervalMs() {
  try {
    const res = await fetch(`${SERVICE_URL}/keepalive/interval`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return DEFAULT_INTERVAL_MS;
    const data = await res.json();
    const n = Number(data?.keepaliveIntervalSeconds);
    return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_INTERVAL_MS;
  } catch {
    return DEFAULT_INTERVAL_MS;
  }
}

// فحص قفل التشابك: هل الخدمة في مزامنة/تنزيل نشط؟
const busyPhases = new Set(["starting", "scanning", "resuming", "captcha-required", "login-required"]);

export function isBusyPhase(phase) {
  return busyPhases.has(String(phase ?? ""));
}

async function serviceBusy() {
  try {
    const res = await fetch(`${SERVICE_URL}/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const st = await res.json();
    return isBusyPhase(st?.phase);
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
    return;
  }
  const wsUrl = await findEtimadTarget();
  if (!wsUrl) {
    console.log(`[${new Date().toISOString()}] ⚠ لا توجد صفحة اعتماد مفتوحة في جلسة Chrome`);
    return;
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
  } catch (error) {
    console.log(`[${new Date().toISOString()}] ✖ خطأ النبضة: ${error.message}`);
  } finally {
    try { ws.close(); } catch {}
  }
}

console.log(`نبضة إبقاء جلسة اعتماد — الفترة تُقرأ من الخدمة، CDP:${CDP_PORT}، قفل تشابك عبر ${SERVICE_URL}/status`);
// لا نبدأ الحلقة عند الاستيراد (للاختبار) — فقط عند التشغيل المباشر.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  // حلقة ذاتية: تُقرأ الفترة من الخدمة قبل كل نبضة فيسري التغيير فورًا.
  for (;;) {
    await pulse();
    await sleep(await currentIntervalMs());
  }
}
