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
import { mkdir, readdir, copyFile, rm } from "node:fs/promises";
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

export function createEtimadLiveDriver({ cdpPort = 9333, downloadPollMs = 250 } = {}) {
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
        await sleep(2_500); // انتظار تحميل معقول — التحقق النهائي عبر DOM
        const evalResult = await sendCdp(ws, "Runtime.evaluate", {
          expression: `(() => {
            const needle = ${JSON.stringify(normalizeArabicText(displayName))};
            const anchors = [...document.querySelectorAll("a")];
            const rows = [...document.querySelectorAll("tr, li, .attachment-row, .files-row")];
            const candidates = [...anchors, ...rows].map((el) => ({
              tag: el.tagName,
              text: (el.innerText ?? el.textContent ?? "").slice(0, 300),
              aria: el.getAttribute("aria-label") ?? "",
              title: el.getAttribute("title") ?? "",
              href: el.getAttribute("href") ?? "",
              rect: (() => { const r = el.getBoundingClientRect?.(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })(),
            }));
            const match = candidates.find((c) =>
              (c.text && c.text.includes(needle)) ||
              (c.aria && c.aria.includes(needle)) ||
              (c.title && c.title.includes(needle)) ||
              (c.href && decodeURIComponent(c.href).includes(needle)));
            return JSON.stringify({ url: location.href, ready: document.readyState, match });
          })()`,
          returnByValue: true,
        });
        const info = JSON.parse(evalResult.result.value ?? "{}");
        if (!info.match) {
          throw liveAcquisitionError("LIVE_TARGET_MISMATCH", `لم يُعثر على عنصر تنزيل يطابق: ${displayName}`);
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

    async acquire({ tender, trustedTenderUrl, displayName, target, quarantinePath, signal, maxBytes, timeoutMs }) {
      void target;
      const { target: page } = await fetchVersionAndTarget(cdpPort);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(liveAcquisitionError("LIVE_CDP_ERROR", "تعذر الاتصال بصفحة Chrome للتنزيل."));
      });
      const quarantineDir = path.dirname(quarantinePath);
      const chromeQuarantineDir = quarantinePath;
      await mkdir(quarantineDir, { recursive: true });
      try {
        // توجيه التنزيلات إلى مجلد الحجر (مطلق بنفس مسار الحجر)
        await sendCdp(ws, "Page.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: quarantineDir,
        });
        await sendCdp(ws, "Page.navigate", { url: trustedTenderUrl });
        await sleep(2_000);
        // النقر على العنصر المطابق displayName فقط — محصور بالنص، بلا selectors شراء
        const needle = normalizeArabicText(displayName);
        await sendCdp(ws, "Runtime.evaluate", {
          expression: `(() => {
            const needle = ${JSON.stringify(needle)};
            const anchors = [...document.querySelectorAll("a")];
            const target = anchors.find((a) => {
              const hay = [a.innerText, a.textContent, a.getAttribute("aria-label"), a.getAttribute("title"), a.getAttribute("href")]
                .map((x) => (x ?? "").toString()).join(" ");
              return hay.includes(needle);
            });
            if (!target) return "NO_MATCH";
            target.scrollIntoView({ block: "center" });
            target.click();
            return "CLICKED";
          })()`,
          returnByValue: true,
        }).then((r) => {
          if (r.result.value !== "CLICKED") throw liveAcquisitionError("LIVE_TARGET_MISMATCH", "تعذر النقر على عنصر التنزيل المطابق.");
        });

        // مراقبة الملف في الحجر حتى يكتمل أو يتجاوز الحجم أو تنتهي المهلة
        const deadline = Date.now() + timeoutMs;
        let lastSize = -1;
        let stableTicks = 0;
        for (;;) {
          if (signal?.aborted) throw liveAcquisitionError("LIVE_ADAPTER_DISABLED", "أُلغيت عملية التنزيل.");
          await sleep(downloadPollMs, undefined, { signal });
          const files = await readdir(quarantineDir).catch(() => []);
          const partFiles = files.filter((f) => f.endsWith(".crdownload") || f.endsWith(".tmp") || f === "download");
          const doneFiles = files.filter((f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp"));
          let totalSize = 0;
          for (const f of [...partFiles, ...doneFiles]) {
            const s = await import("node:fs/promises").then((fs) => fs.stat(path.join(quarantineDir, f)).catch(() => null));
            if (s) totalSize += s.size;
          }
          if (totalSize > maxBytes) throw liveAcquisitionError("LIVE_FILE_TOO_LARGE", `تجاوز الملف ${maxBytes} بايت أثناء النقل.`);
          if (doneFiles.length > 0 && partFiles.length === 0) {
            // اكتمل التنزيل: انسخ الملف المكتمل إلى quarantinePath المتوقع
            const src = path.join(quarantineDir, doneFiles[0]);
            await copyFile(src, quarantinePath);
            await rm(src, { force: true }).catch(() => {});
            return { contentType: null, bytes: totalSize, completedAt: new Date().toISOString() };
          }
          if (totalSize === lastSize) stableTicks += 1; else stableTicks = 0;
          lastSize = totalSize;
          if (Date.now() > deadline) {
            throw liveAcquisitionError("LIVE_DOWNLOAD_TIMEOUT", `تجاوزت محاولة الملف ${Math.round(timeoutMs / 1000)} ثانية.`);
          }
          if (stableTicks > 40 && partFiles.length === 0 && doneFiles.length === 0) {
            throw liveAcquisitionError("LIVE_DOWNLOAD_TIMEOUT", "لم يبدأ التنزيل إطلاقًا خلال المهلة.");
          }
        }
      } finally {
        try { ws.close(); } catch { /* تجاهل */ }
      }
    },
  };
}
