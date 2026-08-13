import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRadarRepository } from "./lib/radar-repository.mjs";
import { createRadarChromeSession } from "./lib/radar-chrome-session.mjs";
import {
  advanceCursor,
  feeBuckets,
  initialCursor,
  mergeTenderAppearances,
  normalizeCursor,
  pageSize,
  regions,
  targetPerRegion,
} from "./lib/sync-plan.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(projectRoot, ".radar-data");
const baselineFile = path.join(projectRoot, "scripts", "sync-baseline.json");
const listUrl = "https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1";
const port = Number(process.env.RADAR_SYNC_PORT || 4318);
const n8nWebhookUrl = process.env.N8N_RADAR_WEBHOOK_URL || "http://127.0.0.1:5678/webhook/radar-sync-5d354757-90d1-4dc3-b7f7-c93e4c50ecb1";
const repository = await createRadarRepository({ projectRoot });
const baselineIds = JSON.parse(await readFile(baselineFile, "utf8"));
repository.seedBaseline(baselineIds);
const chromeSession = createRadarChromeSession({ privateDir, startUrl: listUrl });

let syncPromise;
let state = { phase: "idle", region: null, checked: 0, message: "جاهز", progress: repository.getSyncProgress() };

class LoginRequiredError extends Error {
  constructor(message = "سجّل الدخول إلى اعتماد في نافذة Chrome الخاصة بالرادار، ثم اضغط استئناف المزامنة.") {
    super(message);
    this.code = "LOGIN_REQUIRED";
  }
}

class HumanVerificationRequiredError extends Error {
  constructor() {
    super("اعتماد يطلب تحققًا بشريًا. أكمل CAPTCHA بنفسك في نافذة Chrome، ثم اضغط استئناف المزامنة؛ تم حفظ موضع الجولة.");
    this.code = "CAPTCHA_REQUIRED";
  }
}

async function assertEtimadAuthorized(page) {
  await page.waitForTimeout(400);
  const url = page.url();
  if (url.includes("login.etimad.sa") || !url.includes("tenders.etimad.sa")) throw new LoginRequiredError();
  const challenge = page.locator('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, input[name="cf-turnstile-response"]');
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (await challenge.count() || /verify you are human|تحقق من أنك إنسان|التحقق من أنك إنسان/i.test(bodyText)) {
    throw new HumanVerificationRequiredError();
  }
  return bodyText;
}

async function assertSignedIn(page) {
  const bodyText = await assertEtimadAuthorized(page);
  try {
    await page.locator("#TenderCategory").waitFor({ state: "attached", timeout: 12_000 });
  } catch {
    const latestText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => bodyText);
    if (page.url().includes("login.etimad.sa") || /sign in|تسجيل الدخول|نفاذ/i.test(latestText)) throw new LoginRequiredError();
    throw new LoginRequiredError("لم تظهر صفحة المنافسات المصرح بها. افتح اعتماد وتأكد من بقاء الجلسة، ثم استأنف.");
  }
}

async function inspectTenderDetails(reference) {
  const tender = repository.getTender(reference);
  if (!tender?.etimadUrl) {
    const error = new Error("المنافسة غير موجودة في قاعدة SQLite أو لا تملك رابط تفاصيل صالحًا.");
    error.code = "TENDER_NOT_FOUND";
    throw error;
  }
  const page = await chromeSession.getEtimadPage({ navigate: false });
  await page.goto(tender.etimadUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await assertEtimadAuthorized(page);
  const names = await page.locator('a, button, [role="button"]').evaluateAll((elements) => elements
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
    .filter((text) => text && text.length <= 180 && (/\.pdf|\.xlsx?|\.docx?|كراسة|الغرامات|معايير العروض|المحتوى المحلي|نموذج/i.test(text))));
  const attachmentNames = repository.saveVisibleAttachmentNames(reference, names);
  return { reference, etimadUrl: tender.etimadUrl, attachmentNames, inspectedAt: new Date().toISOString(), downloaded: false };
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
  try {
    await page.waitForURL((url) => parts.every((part) => url.toString().includes(part)), { timeout });
  } catch (error) {
    await assertSignedIn(page);
    throw error;
  }
}

async function applyFilters(page, regionId, feeValue) {
  await assertSignedIn(page);
  await revealSearch(page);
  await page.locator("#TenderCategory").selectOption("2", { force: true });
  await page.locator("#areaList").selectOption([regionId], { force: true });
  await page.locator("#activitiesList").selectOption("2", { force: true });
  await page.locator("#ConditionaBookletRange").selectOption(feeValue, { force: true });
  const searchButton = page.locator("button:visible").filter({ hasText: "بحث" }).last();
  await searchButton.click();
  await waitForUrlParts(page, [`TenderAreasIdString=${regionId}`, `ConditionaBookletRange=${feeValue}`, "PageNumber=1"]);
  await page.waitForTimeout(500);
  const pageSizeSelector = page.locator("#itemsPerPage");
  if (await pageSizeSelector.count() && await pageSizeSelector.inputValue() !== String(pageSize)) {
    await pageSizeSelector.selectOption(String(pageSize));
    await waitForUrlParts(page, [`PageSize=${pageSize}`, "PageNumber=1"]);
    await page.waitForTimeout(500);
  }
  await assertSignedIn(page);
}

async function gotoPageNumber(page, pageNumber) {
  if (pageNumber <= 1) return;
  const url = new URL(page.url());
  url.searchParams.set("PageNumber", String(pageNumber));
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForUrlParts(page, [`PageNumber=${pageNumber}`]);
  await page.waitForTimeout(500);
  await assertSignedIn(page);
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
  }).filter((item) => item?.reference), { regionId, feeBucket });
}

async function hasNextPage(page, currentPage) {
  const expected = currentPage + 1;
  const directLink = page.locator(`a[href*="PageNumber=${expected}"]`);
  if (await directLink.count()) return true;
  const navigation = page.locator('nav[aria-label="Page navigation"]');
  const next = navigation.getByRole("button", { name: /Next|التالي/i });
  return Boolean(await next.count() && await next.isEnabled().catch(() => false));
}

function suitability(item) {
  let score = 60;
  if (item.fee >= 500) score += 6;
  if (/صيانة|ترميم|تأهيل|إنشاء|إصلاح|تطوير/.test(item.title)) score += 8;
  const days = item.deadline ? Math.ceil((Date.parse(item.deadline.replace(" ", "T")) - Date.now()) / 86_400_000) : 10;
  if (days <= 2) score -= 8;
  return Math.max(25, Math.min(90, score));
}

function comparable(item) {
  return JSON.stringify([item.title, item.agency, item.fee, item.region, item.deadline, item.publishedAt]);
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
  return repository.loadState("automation-status", {
    online: false,
    configured: true,
    state: "waiting",
    message: "لم يتم اختبار ربط n8n بعد",
    webhookTarget: "n8n محلي",
  });
}

async function saveAutomationStatus(status) {
  repository.recordAutomationStatus(status);
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

function buildTenderItems(appearances) {
  return mergeTenderAppearances(appearances).map((item) => ({
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
    remoteAttachments: item.remoteAttachments || [],
    etimadUrl: new URL(item.href, "https://tenders.etimad.sa").toString(),
  }));
}

async function performSync() {
  state = { phase: "starting", region: null, checked: 0, message: "الاتصال بجلسة اعتماد البشرية", progress: repository.getSyncProgress() };
  const page = await chromeSession.getEtimadPage();
  await assertSignedIn(page);
  const run = repository.startOrResumeSyncRun({ regions: regions.length, targetPerRegion, initialCursor: initialCursor() });
  const resumedFromCheckpoint = run.resumed;
  let resuming = run.resumed;
  let cursor = normalizeCursor(run.cursor);

  try {
    while (!cursor.complete) {
      const region = regions[cursor.regionIndex];
      const feeBucket = feeBuckets[cursor.feeIndex];
      state = {
        phase: resuming ? "resuming" : "scanning",
        runId: run.id,
        region: region.name,
        regionId: region.id,
        feeBucket: feeBucket.id,
        pageNumber: cursor.pageNumber,
        checked: cursor.checked,
        message: `${resuming ? "استئناف" : "فحص"} ${region.name} — الصفحة ${cursor.pageNumber}`,
        progress: repository.getSyncProgress(),
      };

      await applyFilters(page, region.id, feeBucket.value);
      await gotoPageNumber(page, cursor.pageNumber);
      await assertSignedIn(page);

      const rawBatch = await extractCards(page, region.id, feeBucket.id);
      const remaining = Math.max(0, targetPerRegion - cursor.regionChecked);
      const visibleBatch = rawBatch.slice(0, remaining);
      const eligibleBatch = visibleBatch
        .filter((item) => feeBucket.id === "free" || (item.fee !== null && item.fee <= 600))
        .map((item) => ({ ...item, regionName: region.name, remoteAttachments: [] }));
      const nextAvailable = visibleBatch.length > 0 && await hasNextPage(page, cursor.pageNumber);
      const completedRegionCount = cursor.regionChecked + visibleBatch.length;
      const nextCursor = advanceCursor(cursor, { batchSize: visibleBatch.length, hasNextPage: nextAvailable });

      repository.saveSyncCheckpoint(run.id, {
        regionId: region.id,
        regionName: region.name,
        feeBucket: feeBucket.id,
        pageNumber: cursor.pageNumber,
        checked: nextCursor.checked,
        regionChecked: completedRegionCount,
        items: eligibleBatch,
        nextCursor,
      });
      cursor = nextCursor;
      resuming = false;
    }

    const items = buildTenderItems(repository.loadDraftObservations(run.id));
    const previousItems = repository.loadComparisonItems();
    const previousMap = new Map(previousItems.map((item) => [item.id, item]));
    const added = items.filter((item) => !previousMap.has(item.id));
    const changed = items.filter((item) => previousMap.get(item.id)?.title && comparable(item) !== comparable(previousMap.get(item.id)));
    const result = {
      runId: run.id,
      resumed: resumedFromCheckpoint,
      status: "complete",
      lastSyncAt: new Date().toISOString(),
      checked: cursor.checked,
      regions: regions.length,
      targetPerRegion,
      added,
      changed,
      items,
    };
    repository.saveCompletedSync(result, run.id);
    result.automation = await notifyN8n(result);
    state = {
      phase: "complete",
      runId: run.id,
      region: null,
      checked: result.checked,
      message: `اكتملت المزامنة: ${added.length} جديدة و${changed.length} متغيرة`,
      progress: repository.getSyncProgress(),
    };
    return result;
  } catch (error) {
    const browserClosed = /browser has been closed|target page.*closed|econnrefused|connection closed/i.test(String(error?.message || error));
    const failure = browserClosed ? Object.assign(new Error("أُغلقت نافذة Chrome الخاصة بالرادار. افتح الجلسة مجددًا ثم استأنف المزامنة."), { code: "SESSION_NOT_OPEN" }) : error;
    if (["LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "SESSION_NOT_OPEN"].includes(failure?.code) || repository.hasDraftObservations(run.id)) {
      repository.markSyncPartial(run.id, { cursor, error: failure });
    } else {
      repository.failSyncRun(run.id, failure);
    }
    throw failure;
  }
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

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, {});
  try {
    if (request.method === "GET" && request.url === "/health") {
      return send(response, 200, {
        online: true,
        browser: chromeSession.status(),
        state,
        database: { online: true, schemaVersion: repository.schemaVersion },
      });
    }
    if (request.method === "GET" && request.url === "/status") return send(response, 200, { ...state, progress: repository.getSyncProgress() });
    if (request.method === "GET" && request.url === "/tenders") return send(response, 200, repository.getDashboardSnapshot());
    if (request.method === "GET" && request.url === "/automation/status") return send(response, 200, await loadAutomationStatus());
    if (request.method === "POST" && request.url === "/automation/test") {
      const previous = repository.getDashboardSnapshot();
      const result = {
        lastSyncAt: previous.lastSyncAt || new Date().toISOString(),
        checked: previous.checked || previous.items.length,
        regions: previous.regions || regions.length,
        targetPerRegion: previous.targetPerRegion || targetPerRegion,
        added: [],
        changed: [],
        items: previous.items.filter((item) => item.reference).map((item) => ({ ...item, reference: item.reference || item.id })),
      };
      const automation = await notifyN8n(result, { dryRun: true });
      return send(response, automation.online ? 200 : 503, automation);
    }
    if (request.method === "POST" && request.url === "/session") {
      const session = await chromeSession.openForHumanLogin();
      return send(response, 200, {
        ...session,
        signedIn: false,
        requiresHumanLogin: true,
        message: "سجّل الدخول بنفسك في Chrome. لن يتصل الرادار بالصفحة حتى تبدأ المزامنة.",
      });
    }
    if (request.method === "POST" && request.url === "/details") {
      const body = await readJsonBody(request);
      const details = await inspectTenderDetails(String(body.reference || ""));
      return send(response, 200, details);
    }
    if (request.method === "POST" && request.url === "/sync") {
      if (!syncPromise) syncPromise = performSync().finally(() => { syncPromise = undefined; });
      const result = await syncPromise;
      return send(response, 200, result);
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const status = error?.code === "TENDER_NOT_FOUND" ? 404 : ["LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "SESSION_NOT_OPEN"].includes(error?.code) ? 409 : 500;
    const phase = error?.code === "CAPTCHA_REQUIRED" ? "captcha-required" : status === 409 ? "login-required" : "error";
    state = { ...state, phase, message: error?.message || "تعذر تنفيذ المزامنة", progress: repository.getSyncProgress() };
    return send(response, status, { error: error?.code || "SYNC_FAILED", message: state.message, state });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Etimad sync service: http://127.0.0.1:${port}`));

function shutdown() {
  repository.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
