// P3-B1B/B1C — سائق التنزيل الحي عبر جلسة Chrome البشرية (CDP :9333)
// المالك سجّل دخوله في Chrome المخصص؛ هذا السائق يعيد استخدام نفس الصفحة
// للانتقال لصفحة المنافسة والنقر على زر التنزيل المحدد فقط، ويحفظ الملف
// عبر CDP Page.setDownloadBehavior إلى مجلد الحجر (quarantine).
//
// حواجز مدمجة (ترتيب صارم):
// 1) preflight: الوصول لصفحة تفاصيل المنافسة عبر etimadUrl الموثوق فقط،
//    والتأكد من وجود عنصر تنزيل يطابق displayName (نص/aria/title/href).
// 2) assertSafeDownloadTrigger: رفض أي عنصر يشير لشراء/دفع/تقديم عرض.
// 3) acquire: تنزيل واحد فقط، حجم مباشر مراقَب (maxBytes)، مهلة صارمة.
// 4) نقل ذري: من quarantine إلى المسار النهائي hard-link (لا استبدال ملف قائم).
// السائق لا يقرأ كلمات سر ولا يفتح جلسات جديدة ولا ينفذ أي purchase flow.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { liveAcquisitionError } from "./live-attachment-acquisition.mjs";

const CDP_TIMEOUT_MS = 8_000;

function normalizeArabicText(value) {
  return String(value || "")
    .replaceAll("ـ", "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim()
    .toLocaleLowerCase("ar");
}

// اعتماد يعرض أسماء المرفقات غالبًا بدون الامتداد — نطابق على الجذر
function attachmentNameStems(displayName) {
  const normalized = normalizeArabicText(displayName);
  const stem = normalized.replace(/\.(pdf|zip|rar|docx?|xlsx?|pptx?)$/u, "").trim();
  const stems = [...new Set([normalized, stem].filter((v) => v && v.length >= 4))];
  return stems;
}

// اعتماد يعيد توجيه صفحة التفاصيل من `Details` إلى `DetailsForSupplier` (رؤية المورّد).
// الاعتماد على readyState وحده خطأ: قد يُعلن "complete" على الصفحة الوسيطة قبل اكتمال
// إعادة التوجيه، فينقر السائق تبويب المرفق على صفحة خاطئة فيفشل المطابقة. ننتظر هنا
// استقرار عنوان الصفحة النهائي (DetailsForSupplier) مكتمل التحميل.
export function isDetailsForSupplierUrl(url) {
  return /tenders\.etimad\.sa\/Tender\/DetailsForSupplier/i.test(String(url || ""));
}

export async function waitForSettledTenderPage({
  getState,
  sleepFn = sleep,
  pollMs = 1_200,
  deadlineMs = 15_000,
  stability = 2,
}) {
  const deadline = Date.now() + deadlineMs;
  let prevUrl = null;
  let stableCount = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw liveAcquisitionError("LIVE_CDP_TIMEOUT", "لم تستقر صفحة المنافسة على DetailsForSupplier خلال المهلة (إعادة توجيه لم تكتمل).");
    }
    const { url, readyState } = await getState();
    const settled = isDetailsForSupplierUrl(url) && readyState === "complete";
    if (settled) {
      if (url === prevUrl) {
        stableCount += 1;
        if (stableCount >= stability) return { url, readyState };
      } else {
        stableCount = 1;
        prevUrl = url;
      }
    } else {
      stableCount = 0;
      prevUrl = url;
    }
    await sleepFn(pollMs);
  }
}

let cdpMessageId = 0;
async function sendCdp(ws, method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
  const id = ++cdpMessageId;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(liveAcquisitionError("LIVE_CDP_TIMEOUT", `انتهت مهلة CDP: ${method}`)), timeoutMs);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (msg.error) reject(liveAcquisitionError("LIVE_CDP_ERROR", `CDP ${method}: ${msg.error.message ?? "خطأ"}`));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(payload);
  });
}

async function fetchVersionAndTarget(port) {
  let version;
  try {
    version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
  } catch {
    throw liveAcquisitionError("LIVE_CDP_UNREACHABLE", "جلسة Chrome البشرية غير متاحة — شغّل الرادار وسجّل الدخول أولًا.");
  }
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && (t.url ?? "").includes("tenders.etimad.sa"))
    ?? targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw liveAcquisitionError("LIVE_CDP_NO_PAGE", "لا توجد صفحة متاحة في جلسة Chrome.");
  return { browser: version.Browser ?? "", target: page };
}

export function createEtimadLiveDriver({ cdpPort = 9333 } = {}) {
  return {
    kind: "etimad-human-chrome-cdp",
    async preflight({ tender, trustedTenderUrl, displayName }) {
      const { target } = await fetchVersionAndTarget(cdpPort);
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(liveAcquisitionError("LIVE_CDP_ERROR", "تعذر الاتصال بصفحة Chrome."));
      });
      try {
        // تنقل موثوق: نفس etimadUrl المخزن (مصادق عليه في assertTrustedTenderUrl سابقًا)
        await sendCdp(ws, "Page.navigate", { url: trustedTenderUrl });
        const stems = attachmentNameStems(displayName);
        let info = null;
        // انتظار استقرار الصفحة النهائية (DetailsForSupplier مكتملة) بدل readyState وحده —
        // اعتماد يعيد التوجيه Details→DetailsForSupplier؛ النقر قبل الاستقرار يفشل المطابقة.
        await waitForSettledTenderPage({
          getState: async () => {
            const r = await sendCdp(ws, "Runtime.evaluate", {
              expression: "JSON.stringify({ url: location.href, readyState: document.readyState })",
              returnByValue: true,
            });
            return JSON.parse(r.result?.value ?? "{}");
          },
        });
        // مرفقات اعتماد داخل تبويب «المرفق» — انقره أولًا (قد يكون MDC أو mat)
        await sendCdp(ws, "Runtime.evaluate", {
          expression: `(() => {
            const tabs = [...document.querySelectorAll('.mat-tab-label, .mdc-tab, [role=tab]')];
            const att = tabs.find((t) => (t.innerText || '').includes('المرفق'));
            att?.click();
            return att ? 'TAB_CLICKED' : 'TAB_NOT_FOUND';
          })()`,
          returnByValue: true,
        });

        // حتى 4 محاولات فحص DOM بفواصل — قسم المرفقات قد يتأخر تحميله
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await sleep(attempt === 0 ? 800 : 2_200);
          const evalResult = await sendCdp(ws, "Runtime.evaluate", {
            expression: `(() => {
              const stems = ${JSON.stringify(stems)};
              const anchors = [...document.querySelectorAll("a, button, [role=button]")];
              const rows = [...document.querySelectorAll("tr, li, .attachment-row, .files-row")];
              const candidates = [...anchors, ...rows].map((el) => ({
                tag: el.tagName,
                text: (el.innerText ?? el.textContent ?? "").slice(0, 300),
                aria: el.getAttribute("aria-label") ?? "",
                title: el.getAttribute("title") ?? "",
                href: el.getAttribute("href") ?? "",
                rect: (() => { const r = el.getBoundingClientRect?.(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })(),
              }));
              const norm = (v) => String(v || "").replaceAll("ـ", "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim().toLowerCase();
              const hits = (c) => {
                const hay = norm([c.text, c.aria, c.title].filter(Boolean).join(" "));
                const href = c.href ? norm(decodeURIComponent(c.href)) : "";
                return stems.some((s) => hay.includes(s) || href.includes(s));
              };
              const match = candidates.find(hits);
              return JSON.stringify({ url: location.href, ready: document.readyState, match,
                attachmentsHint: (document.body.innerText.match(/المرفقات|الملفات/g) || []).length });
            })()`,
            returnByValue: true,
          });
          info = JSON.parse(evalResult.result.value ?? "{}");
          if (info.match) break;
        }
        if (!info?.match) {
          throw liveAcquisitionError("LIVE_TARGET_MISMATCH", `لم يُعثر على عنصر تنزيل يطابق: ${displayName} (بعد انتظار وإعادة فحص صفحة المنافسة)`);
        }
        return {
          ready: info.ready === "complete",
          tenderReference: tender.reference,
          displayName,
          targetId: `${target.id}`,
          elementInfo: {
            text: info.match.text ?? "",
            href: info.match.href ?? "",
            ariaLabel: info.match.aria ?? "",
            title: info.match.title ?? "",
          },
        };
      } finally {
        try { ws.close(); } catch { /* تجاهل */ }
      }
    },

    async acquire({ trustedTenderUrl, displayName, target, quarantinePath, signal, maxBytes, timeoutMs }) {
      void target;
      const { target: page } = await fetchVersionAndTarget(cdpPort);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(liveAcquisitionError("LIVE_CDP_ERROR", "تعذر الاتصال بصفحة Chrome للتنزيل."));
      });
      try {
        await sendCdp(ws, "Page.enable");
        await sendCdp(ws, "Page.navigate", { url: trustedTenderUrl });
        // انتظار استقرار الصفحة النهائية (DetailsForSupplier مكتملة) قبل نقر تبويب المرفق.
        await waitForSettledTenderPage({
          deadlineMs: Math.max(timeoutMs, 15_000),
          getState: async () => {
            const r = await sendCdp(ws, "Runtime.evaluate", {
              expression: "JSON.stringify({ url: location.href, readyState: document.readyState })",
              returnByValue: true,
            });
            return JSON.parse(r.result?.value ?? "{}");
          },
          sleepFn: async (ms) => {
            await sleep(ms);
            if (signal?.aborted) throw liveAcquisitionError("LIVE_ADAPTER_DISABLED", "أُلغيت عملية التنزيل.");
          },
        });
        await sleep(1_000);
        await sendCdp(ws, "Runtime.evaluate", {
          expression: `(() => {
            const tabs = [...document.querySelectorAll('.mat-tab-label, .mdc-tab, [role=tab]')];
            const att = tabs.find((t) => (t.innerText || '').includes('المرفق'));
            att && att.click();
          })()`,
          returnByValue: true,
        });
        await sleep(3_000);

        const stems = attachmentNameStems(displayName);
        const anchorInfo = await sendCdp(ws, "Runtime.evaluate", {
          expression: `(() => {
            const stems = ${JSON.stringify(stems)};
            const norm = (v) => String(v || "").replaceAll("ـ", "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim().toLowerCase();
            const a = [...document.querySelectorAll("a")].find((el) => {
              const hay = norm([el.innerText, el.textContent].map((x) => (x || "").toString()).join(" "));
              return stems.some((s) => hay.includes(s));
            });
            if (!a) return "NO_MATCH";
            const onclick = a.getAttribute("onclick") || "";
            const m = onclick.match(/RedirectURL\\s*\\(\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*\\)/);
            if (!m) return JSON.stringify({ noRedirect: true, outer: a.outerHTML.slice(0, 200) });
            return JSON.stringify({ guid: m[1], fileName: m[2] });
          })()`,
          returnByValue: true,
        });
        const anchorRaw = anchorInfo.result?.value;
        if (anchorRaw === "NO_MATCH") {
          throw liveAcquisitionError("LIVE_TARGET_MISMATCH", `لم يُعثر على رابط تنزيل يطابق: ${displayName}`);
        }
        const anchor = JSON.parse(anchorRaw);
        if (anchor.noRedirect) {
          throw liveAcquisitionError("LIVE_TARGET_MISMATCH", "رابط الملف لا يحمل نمط RedirectURL المعروف — قد تكون الواجهة تغيرت.");
        }

        const fetchRes = await sendCdp(ws, "Runtime.evaluate", {
          expression: `(async () => {
            const resp = await fetch('/Upload/getfile/' + ${JSON.stringify(anchor.guid)} + ':' + ${JSON.stringify(anchor.fileName)}, { credentials: 'include' });
            const ct = resp.headers.get('content-type');
            const cd = resp.headers.get('content-disposition');
            if (!resp.ok) return JSON.stringify({ err: resp.status, ct });
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            if (bytes.length > ${Math.min(maxBytes, 80 * 1024 * 1024)}) return JSON.stringify({ err: 'TOO_LARGE', bytes: bytes.length });
            let bin = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            return JSON.stringify({ ct, cd, bytes: bytes.length, b64: btoa(bin) });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const inner = fetchRes.result?.value;
        if (!inner) throw liveAcquisitionError("LIVE_DOWNLOAD_FAILED", "لم تُعد الصفحة نتيجة الجلب.");
        const fetched = JSON.parse(inner);
        if (fetched.err === "TOO_LARGE") throw liveAcquisitionError("LIVE_FILE_TOO_LARGE", "تجاوز الملف الحد المسموح.");
        if (fetched.err) throw liveAcquisitionError("LIVE_DOWNLOAD_FAILED", `رفض الخادم الطلب: ${fetched.err} ${fetched.ct ?? ""}`);
        const bytes = Buffer.from(fetched.b64, "base64");
        if (bytes.length > maxBytes) throw liveAcquisitionError("LIVE_FILE_TOO_LARGE", `تجاوز الملف ${maxBytes} بايت.`);
        await mkdir(path.dirname(quarantinePath), { recursive: true });
        await writeFile(quarantinePath, bytes);
        return { contentType: fetched.ct ?? null, bytes: bytes.length, completedAt: new Date().toISOString() };
      } finally {
        try { ws.close(); } catch { /* تجاهل */ }
      }
    },
  };
}
