import http from "node:http";
import path from "node:path";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(projectRoot, ".radar-data");
const profileDir = path.join(privateDir, "etimad-chrome-profile");
const dataFile = path.join(privateDir, "etimad-sync.json");
const automationFile = path.join(privateDir, "n8n-automation.json");
const automationHistoryFile = path.join(privateDir, "n8n-automation-history.ndjson");
const baselineFile = path.join(projectRoot, "scripts", "sync-baseline.json");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const listUrl = "https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1";
const port = 4318;
const n8nWebhookUrl = process.env.N8N_RADAR_WEBHOOK_URL || "http://127.0.0.1:5678/webhook/radar-sync-5d354757-90d1-4dc3-b7f7-c93e4c50ecb1";
const regionNames = {
  "1": "منطقة الرياض", "2": "منطقة مكة المكرمة", "3": "منطقة المدينة المنورة", "4": "منطقة القصيم",
  "5": "المنطقة الشرقية", "6": "منطقة عسير", "7": "منطقة تبوك", "8": "منطقة حائل",
  "9": "منطقة الحدود الشمالية", "10": "منطقة جازان", "11": "منطقة نجران", "12": "منطقة الباحة", "13": "منطقة الجوف",
};

let browserContext;
let syncPromise;
let state = { phase: "idle", region: null, checked: 0, message: "جاهز" };

class LoginRequiredError extends Error {
  constructor() { super("سجّل الدخول إلى اعتماد في نافذة الرادار ثم أعد المزامنة."); this.code = "LOGIN_REQUIRED"; }
}

async function ensurePrivateDir() { await mkdir(privateDir, { recursive: true }); }

async function getContext() {
  if (browserContext) return browserContext;
  await ensurePrivateDir();
  browserContext = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-features=Translate"],
  });
  browserContext.on("close", () => { browserContext = undefined; });
  return browserContext;
}

async function getEtimadPage({ navigate = true } = {}) {
  const context = await getContext();
  let page = context.pages().find((candidate) => candidate.url().includes("etimad.sa"));
  if (!page) page = context.pages()[0] ?? await context.newPage();
  if (navigate && !page.url().includes("tenders.etimad.sa/Tender/AllSuppliersTenders")) {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  await page.bringToFront();
  return page;
}

async function assertSignedIn(page) {
  await page.waitForTimeout(600);
  if (page.url().includes("login.etimad.sa") || !page.url().includes("tenders.etimad.sa")) throw new LoginRequiredError();
  try { await page.locator("#TenderCategory").waitFor({ state: "attached", timeout: 12_000 }); }
  catch { throw new LoginRequiredError(); }
}

async function revealSearch(page) {
  if (!(await page.locator('button[data-id="TenderCategory"]').isVisible().catch(() => false))) {
    const topSearch = page.getByRole("button", { name: /بحث/ }).first();
    if (await topSearch.count()) await topSearch.click();
  }
  for (const target of ["#basicInfo", "#dates"]) {
    const panel = page.locator(target);
    if (await panel.count() && !(await panel.getAttribute("class") ?? "").includes("show")) {
      await page.locator(`a[href="${target}"]`).click({ force: true });
    }
  }
}

async function waitForUrlParts(page, parts, timeout = 20_000) {
  await page.waitForURL((url) => parts.every((part) => url.toString().includes(part)), { timeout });
}

async function applyFilters(page, regionId, feeValue) {
  await revealSearch(page);
  await page.locator("#TenderCategory").selectOption("2", { force: true });
  await page.locator("#areaList").selectOption([regionId], { force: true });
  await page.locator("#activitiesList").selectOption("2", { force: true });
  await page.locator("#ConditionaBookletRange").selectOption(feeValue, { force: true });
  const searchButton = page.locator("button:visible").filter({ hasText: "بحث" }).last();
  await searchButton.click();
  await waitForUrlParts(page, [`TenderAreasIdString=${regionId}`, `ConditionaBookletRange=${feeValue}`, "PageNumber=1"]);
  await page.waitForTimeout(650);
  const pageSize = page.locator("#itemsPerPage");
  if (await pageSize.count() && await pageSize.inputValue() !== "24") {
    await pageSize.selectOption("24");
    await waitForUrlParts(page, ["PageSize=24", "PageNumber=1"]);
    await page.waitForTimeout(650);
  }
}

async function extractCards(page, regionId, feeBucket) {
  return page.locator("div.card").evaluateAll((cards, args) => cards.map((card) => {
    const link = card.querySelector('h5 a[href*="/Tender/Details"]');
    if (!link) return null;
    const text = (card.innerText || "").replace(/\r/g, "");
    const reference = (text.match(/الرقم المرجعي\s*\n?\s*(\d{12})/) || [])[1] || "";
    const feeMatch = text.match(/قيمة وثائق المنافسة\s*\n?\s*[^\d]*(\d[\d,]*)/);
    const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
    const headings = [...card.querySelectorAll("h5")].map((item) => (item.textContent || "").trim()).filter(Boolean);
    return {
      reference,
      title: (link.textContent || "").trim(),
      agency: headings[1] || "",
      fee: args.feeBucket === "free" ? 0 : (feeMatch ? Number(feeMatch[1].replaceAll(",", "")) : null),
      publishedAt: dates[0] || "",
      deadline: dates[1] ? `${dates[1]} 09:59` : "",
      href: link.getAttribute("href") || "",
      regionId: args.regionId,
    };
  }).filter(Boolean), { regionId, feeBucket });
}

async function scanPages(page, regionId, feeBucket, limit) {
  const collected = [];
  for (let pageNumber = 1; pageNumber <= Math.ceil(limit / 24) && collected.length < limit; pageNumber += 1) {
    const batch = await extractCards(page, regionId, feeBucket);
    for (const item of batch) if (!collected.some((candidate) => candidate.reference === item.reference)) collected.push(item);
    const navigation = page.locator('nav[aria-label="Page navigation"]');
    const next = navigation.getByRole("button", { name: "Next", exact: true });
    if (collected.length >= limit || !(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
    await waitForUrlParts(page, [`PageNumber=${pageNumber + 1}`]);
    await page.waitForTimeout(650);
  }
  return collected.slice(0, limit);
}

async function scanBucket(page, regionId, feeValue, limit) {
  await applyFilters(page, regionId, feeValue);
  if (await page.getByText("لا توجد بيانات", { exact: true }).count()) return [];
  return scanPages(page, regionId, feeValue === "0" ? "free" : "paid", limit);
}

function suitability(item) {
  let score = 60;
  if (item.fee >= 500) score += 6;
  if (/صيانة|ترميم|تأهيل|إنشاء|إصلاح|تطوير/.test(item.title)) score += 8;
  const days = item.deadline ? Math.ceil((Date.parse(item.deadline.replace(" ", "T")) - Date.now()) / 86_400_000) : 10;
  if (days <= 2) score -= 8;
  return Math.max(25, Math.min(90, score));
}

async function loadPrevious() {
  try { return JSON.parse(await readFile(dataFile, "utf8")); }
  catch {
    const ids = JSON.parse(await readFile(baselineFile, "utf8"));
    return { lastSyncAt: null, items: ids.map((id) => ({ id })) };
  }
}

function comparable(item) { return JSON.stringify([item.title, item.agency, item.fee, item.region, item.deadline, item.publishedAt]); }

async function saveResult(result) {
  await ensurePrivateDir();
  const temporary = `${dataFile}.tmp`;
  await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
  await rename(temporary, dataFile);
}

function toAutomationTender(item) {
  return {
    reference: item.reference,
    title: item.title,
    agency: item.agency,
    fee: item.fee,
    region: item.region,
    deadline: item.deadline,
    publishedAt: item.publishedAt,
    platformStatus: item.platformStatus,
    activity: item.activity,
    etimadUrl: item.etimadUrl,
  };
}

async function loadAutomationStatus() {
  try { return JSON.parse(await readFile(automationFile, "utf8")); }
  catch {
    return {
      online: false,
      configured: true,
      state: "waiting",
      message: "لم يتم اختبار ربط n8n بعد",
      webhookTarget: "n8n محلي",
    };
  }
}

async function saveAutomationStatus(status) {
  await ensurePrivateDir();
  const temporary = `${automationFile}.tmp`;
  await writeFile(temporary, JSON.stringify(status, null, 2), "utf8");
  await rename(temporary, automationFile);
  if (status.lastSuccessAt && !status.dryRun) {
    const historyLine = JSON.stringify({
      recordedAt: status.lastSuccessAt,
      syncId: status.syncId,
      state: status.state,
      counts: status.counts,
      message: status.message,
    });
    await appendFile(automationHistoryFile, `${historyLine}\n`, "utf8");
  }
}

async function notifyN8n(result, { dryRun = false } = {}) {
  const attemptedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    source: "tender-radar",
    syncId: dryRun ? `connectivity-${Date.now()}` : result.lastSyncAt,
    occurredAt: result.lastSyncAt,
    dryRun,
    scope: {
      regions: result.regions,
      targetPerRegion: result.targetPerRegion,
      checked: result.checked,
      activity: "المقاولات",
      maximumBookletFee: 600,
    },
    declaredAdded: result.added.map((item) => item.reference),
    declaredChanged: result.changed.map((item) => item.reference),
    items: result.items.map(toAutomationTender),
  };

  try {
    const response = await fetch(n8nWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Tender-Radar/1.0" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.message || `استجابة n8n غير ناجحة (${response.status})`);
    const status = {
      online: true,
      configured: true,
      state: body.duplicate ? "duplicate" : body.counts?.new > 0 || body.counts?.changed > 0 ? "changes" : "ready",
      workflow: body.workflow || "Radar Phase 1",
      syncId: body.syncId || payload.syncId,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: new Date().toISOString(),
      counts: body.counts || { new: 0, changed: 0, unchanged: payload.items.length },
      message: body.alert?.message || body.message || "تم تسليم نتيجة المزامنة إلى n8n",
      dryRun,
    };
    await saveAutomationStatus(status);
    return status;
  } catch (error) {
    const status = {
      online: false,
      configured: true,
      state: "error",
      lastAttemptAt: attemptedAt,
      message: `اكتملت مزامنة اعتماد، لكن تعذر تسليم النتيجة إلى n8n: ${error?.message || "خطأ اتصال"}`,
      dryRun,
    };
    await saveAutomationStatus(status);
    return status;
  }
}

async function performSync() {
  state = { phase: "starting", region: null, checked: 0, message: "فتح جلسة اعتماد" };
  const page = await getEtimadPage();
  await assertSignedIn(page);
  const appearances = [];
  let checked = 0;
  for (const regionId of Object.keys(regionNames)) {
    state = { phase: "scanning", region: regionNames[regionId], checked, message: `فحص ${regionNames[regionId]}` };
    const free = await scanBucket(page, regionId, "0", 100);
    const paidRaw = await scanBucket(page, regionId, "1", Math.max(0, 100 - free.length));
    checked += free.length + paidRaw.length;
    const eligible = [...free, ...paidRaw.filter((item) => item.fee !== null && item.fee <= 600)];
    for (const item of eligible) appearances.push({ ...item, regionName: regionNames[regionId] });
  }

  const unique = new Map();
  for (const item of appearances) {
    if (!unique.has(item.reference)) unique.set(item.reference, { ...item, regions: [] });
    unique.get(item.reference).regions.push(item.regionName);
  }
  const items = [...unique.values()].map((item) => ({
    id: item.reference,
    reference: item.reference,
    title: item.title,
    agency: item.agency,
    fee: item.fee ?? 0,
    region: item.regions.length > 1 ? `متعدد المناطق: ${item.regions.join("، ")}` : item.regions[0],
    deadline: item.deadline,
    publishedAt: item.publishedAt,
    status: "جديدة",
    documents: "لم تُفتح",
    score: suitability(item),
    platformStatus: "المنافسات النشطة (تقديم العروض)",
    activity: "المقاولات",
    etimadUrl: new URL(item.href, "https://tenders.etimad.sa").toString(),
  }));

  const previous = await loadPrevious();
  const previousMap = new Map(previous.items.map((item) => [item.id, item]));
  const added = items.filter((item) => !previousMap.has(item.id));
  const changed = items.filter((item) => previousMap.get(item.id)?.title && comparable(item) !== comparable(previousMap.get(item.id)));
  const result = { lastSyncAt: new Date().toISOString(), checked, regions: 13, targetPerRegion: 100, added, changed, items };
  await saveResult(result);
  result.automation = await notifyN8n(result);
  await saveResult(result);
  state = { phase: "complete", region: null, checked, message: `اكتملت المزامنة: ${added.length} جديدة و${changed.length} متغيرة` };
  return result;
}

function send(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, {});
  try {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { online: true, browserOpen: Boolean(browserContext), state });
    if (request.method === "GET" && request.url === "/status") return send(response, 200, state);
    if (request.method === "GET" && request.url === "/automation/status") return send(response, 200, await loadAutomationStatus());
    if (request.method === "POST" && request.url === "/automation/test") {
      const previous = await loadPrevious();
      const result = {
        lastSyncAt: previous.lastSyncAt || new Date().toISOString(),
        checked: previous.checked || previous.items.length,
        regions: previous.regions || 13,
        targetPerRegion: previous.targetPerRegion || 100,
        added: [],
        changed: [],
        items: previous.items.filter((item) => item.reference).map((item) => ({ ...item, reference: item.reference || item.id })),
      };
      const automation = await notifyN8n(result, { dryRun: true });
      return send(response, automation.online ? 200 : 503, automation);
    }
    if (request.method === "POST" && request.url === "/session") {
      const page = await getEtimadPage();
      return send(response, 200, { opened: true, signedIn: page.url().includes("tenders.etimad.sa") && !page.url().includes("login.etimad.sa") });
    }
    if (request.method === "POST" && request.url === "/sync") {
      if (!syncPromise) syncPromise = performSync().finally(() => { syncPromise = undefined; });
      const result = await syncPromise;
      return send(response, 200, result);
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const status = error?.code === "LOGIN_REQUIRED" ? 409 : 500;
    state = { ...state, phase: status === 409 ? "login-required" : "error", message: error?.message || "تعذر تنفيذ المزامنة" };
    return send(response, status, { error: error?.code || "SYNC_FAILED", message: state.message, state });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Etimad sync service: http://127.0.0.1:${port}`));

async function shutdown() {
  await browserContext?.close().catch(() => {});
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
