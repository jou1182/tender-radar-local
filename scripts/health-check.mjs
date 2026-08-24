// CLI فحص الصحة المحلي — P4-O0A
// الاستخدام: node scripts/health-check.mjs
// فحوص loopback فقط للخدمات المحلية للمشروع نفسه:
//   - الواجهة على http://localhost:3000
//   - خدمة المزامنة على http://127.0.0.1:4318/health
//   - نقطة صحة التحليل على http://127.0.0.1:4318/analysis/health
// أي مضيف آخر مرفوض تصميميًا (SAFETY_BOUNDARIES: منع الاتصال الخارجي).
// الخرج: JSON واحد؛ exit 0 فقط إذا نجحت كل الفحوص.

function assertLoopbackUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`non-http url rejected: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`non-loopback host rejected: ${parsed.hostname}`);
  }
  return parsed;
}

async function fetchJsonHealth(rawUrl, timeoutMs = 4000) {
  const parsed = assertLoopbackUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok && !!body, status: response.status, hasJsonBody: !!body };
  } finally {
    clearTimeout(timer);
  }
}

async function checkUi() {
  // الواجهة قد تعرض HTML عاديًا — يكفي أن ترد استجابة من أي حالة.
  const parsed = assertLoopbackUrl("http://localhost:3000/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(parsed, { method: "GET", signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const checks = {};
  let allOk = true;

  try {
    checks.ui = { ...(await checkUi()), endpoint: "http://localhost:3000/" };
  } catch (error) {
    checks.ui = { ok: false, error: String(error?.message || error) };
  }
  allOk = allOk && checks.ui.ok === true;

  for (const [key, rawUrl] of [
    ["syncService", "http://127.0.0.1:4318/health"],
    ["analysisHealth", "http://127.0.0.1:4318/analysis/health"],
  ]) {
    try {
      checks[key] = { ...(await fetchJsonHealth(rawUrl)), endpoint: rawUrl };
    } catch (error) {
      checks[key] = { ok: false, error: String(error?.message || error), endpoint: rawUrl };
    }
    allOk = allOk && checks[key].ok === true;
  }

  console.log(JSON.stringify({ ok: allOk, checkedAt: new Date().toISOString(), checks }, null, 2));
  process.exitCode = allOk ? 0 : 1;
}

await main();
