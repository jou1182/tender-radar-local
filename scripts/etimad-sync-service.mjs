import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRadarRepository } from "./lib/radar-repository.mjs";
import { createRadarChromeSession } from "./lib/radar-chrome-session.mjs";
import {
  buildDetailRecord,
  cleanDetailText,
  selectVisibleAttachmentNames,
  shouldRetryDetailRead,
} from "./lib/etimad-detail-parser.mjs";
import {
  advanceCursor,
  defaultPlan,
  initialCursor,
  mergeTenderAppearances,
  normalizeCursor,
  pageSize,
  planFromSearchProfile,
} from "./lib/sync-plan.mjs";
import { createDisabledProductionDownloadAdapter } from "./lib/attachment-adapters.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(projectRoot, ".radar-data");
const baselineFile = path.join(projectRoot, "scripts", "sync-baseline.json");
const listUrl = "https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1";
const port = Number(process.env.RADAR_SYNC_PORT || 4318);
const serviceVersion = "p3b-approval-gate-1";
const n8nWebhookUrl = process.env.N8N_RADAR_WEBHOOK_URL || "http://127.0.0.1:5678/webhook/radar-sync-5d354757-90d1-4dc3-b7f7-c93e4c50ecb1";
const repository = await createRadarRepository({ projectRoot });
const baselineIds = JSON.parse(await readFile(baselineFile, "utf8"));
repository.seedBaseline(baselineIds);
const chromeSession = createRadarChromeSession({ privateDir, startUrl: listUrl });
// المحوّل الوحيد في P3-B0: أي محاولة تنفيذ حي تعيد DOWNLOAD_ADAPTER_DISABLED.
const downloadAdapter = createDisabledProductionDownloadAdapter();

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
  const firstBody = await assertEtimadAuthorized(page);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

  const sections = [];
  const attachmentNames = [];
  const captureVisibleAttachmentNames = async (rootSelector) => {
    const candidates = await page.locator(rootSelector).locator('.etd-item-title, a, button, [role="button"], [download]').evaluateAll((elements) => elements
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map((element) => ({
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        fileName: decodeURIComponent((element.getAttribute("href") || "").split("/").pop()?.split("?")[0] || ""),
      })));
    attachmentNames.push(...selectVisibleAttachmentNames(candidates));
  };
  const readVisiblePanel = async () => page.locator('.tab-pane.active, [role="tabpanel"]:visible, .tab-content .active:visible, main:visible').evaluateAll((elements) => {
    const texts = elements
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map((element) => (element.innerText || "").trim())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    return texts[0] || "";
  }).catch(() => "");

  const initialText = cleanDetailText((await readVisiblePanel()) || firstBody).slice(0, 35_000);
  if (initialText) sections.push({ name: "صفحة تفاصيل المنافسة", text: initialText });

  const tabs = await page.locator('a.nav-link[href^="#d-"]').evaluateAll((elements) => elements
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    .map((element) => ({
      target: element.getAttribute("href") || "",
      name: (element.textContent || "").replace(/\s+/g, " ").trim().replace(/^(?:dashboard|schedule|list|table_chart|attach_file|home)\s+/i, ""),
    }))
    .filter((item) => /^#d-\d+$/.test(item.target) && item.name));

  const readTabSections = async () => {
    for (const tab of tabs) {
      if (sections.some((section) => section.name === tab.name)) continue;
      await page.locator(`a.nav-link[href="${tab.target}"]`).first().click({ timeout: 4_000 }).catch(() => {});
      await page.waitForTimeout(550);
      await assertEtimadAuthorized(page);
      const text = cleanDetailText(await page.locator(tab.target).innerText().catch(() => "")).slice(0, 35_000);
      if (text && !sections.some((section) => section.text === text)) sections.push({ name: tab.name, text });
      if (tab.target === "#d-5") await captureVisibleAttachmentNames(tab.target);
    }
  };

  await readTabSections();
  if (shouldRetryDetailRead({ visibleTabCount: tabs.length, sectionsRead: sections.length })) {
    // محاولة واحدة محدودة عند نقص الأقسام رغم ظهور التبويبات، ثم يحسم buildDetailRecord الوسم النهائي.
    await page.waitForTimeout(1_200);
    await readTabSections();
  }

  const record = buildDetailRecord({ reference, sourceUrl: page.url(), pageTitle: await page.title(), sections, attachmentNames, visibleTabCount: tabs.length });
  const storedTender = repository.saveTenderDetails(record);
  return {
    reference,
    etimadUrl: tender.etimadUrl,
    attachmentNames: storedTender.remoteAttachments || [],
    details: storedTender.details,
    inspectedAt: record.inspectedAt,
    downloaded: false,
  };
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

async function applyFilters(page, regionId, feeValue, activityValue) {
  if (!activityValue) {
    const error = new Error("لا يمكن بدء المزامنة دون قيمة نشاط مؤكدة من اعتماد.");
    error.code = "INVALID_PROFILE";
    throw error;
  }
  await assertSignedIn(page);
  await revealSearch(page);
  await page.locator("#TenderCategory").selectOption("2", { force: true });
  await page.locator("#areaList").selectOption([regionId], { force: true });
  await page.locator("#activitiesList").selectOption(activityValue, { force: true });
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
      activity: result.scope?.activity || defaultPlan.activityName,
      maximumBookletFee: result.scope?.maximumBookletFee ?? defaultPlan.feeMax,
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

function buildTenderItems(appearances, plan = defaultPlan) {
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
    activity: plan.activityName,
    remoteAttachments: item.remoteAttachments || [],
    etimadUrl: new URL(item.href, "https://tenders.etimad.sa").toString(),
  }));
}

async function performSync() {
  state = { phase: "starting", region: null, checked: 0, message: "الاتصال بجلسة اعتماد البشرية", progress: repository.getSyncProgress() };
  const profile = repository.getEnabledSearchProfile();
  const plan = profile ? planFromSearchProfile(profile) : defaultPlan;
  const page = await chromeSession.getEtimadPage();
  await assertSignedIn(page);
  const run = repository.startOrResumeSyncRun({ regions: plan.regions.length, targetPerRegion: plan.targetPerRegion, initialCursor: initialCursor(plan) });
  const resumedFromCheckpoint = run.resumed;
  let resuming = run.resumed;
  let cursor = normalizeCursor(run.cursor, plan);

  try {
    while (!cursor.complete) {
      const region = plan.regions[cursor.regionIndex];
      const feeBucket = plan.feeBuckets[cursor.feeIndex];
      state = {
        phase: resuming ? "resuming" : "scanning",
        runId: run.id,
        region: region.name,
        regionId: region.id,
        feeBucket: feeBucket.id,
        pageNumber: cursor.pageNumber,
        checked: cursor.checked,
        profile: plan.activityName,
        message: `${resuming ? "استئناف" : "فحص"} ${region.name} — الصفحة ${cursor.pageNumber}`,
        progress: repository.getSyncProgress(),
      };

      await applyFilters(page, region.id, feeBucket.value, plan.activityValue);
      await gotoPageNumber(page, cursor.pageNumber);
      await assertSignedIn(page);

      const rawBatch = await extractCards(page, region.id, feeBucket.id);
      const remaining = Math.max(0, plan.targetPerRegion - cursor.regionChecked);
      const visibleBatch = rawBatch.slice(0, remaining);
      const eligibleBatch = visibleBatch
        .filter((item) => feeBucket.id === "free" || (item.fee !== null && item.fee >= plan.feeMin && item.fee <= plan.feeMax))
        .map((item) => ({ ...item, regionName: region.name, remoteAttachments: [] }));
      const nextAvailable = visibleBatch.length > 0 && await hasNextPage(page, cursor.pageNumber);
      const completedRegionCount = cursor.regionChecked + visibleBatch.length;
      const nextCursor = advanceCursor(cursor, { batchSize: visibleBatch.length, hasNextPage: nextAvailable }, plan);

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

    const items = buildTenderItems(repository.loadDraftObservations(run.id), plan);
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
      regions: plan.regions.length,
      targetPerRegion: plan.targetPerRegion,
      added,
      changed,
      items,
      scope: {
        activity: plan.activityName,
        activityValue: plan.activityValue,
        minimumBookletFee: plan.feeMin,
        maximumBookletFee: plan.feeMax,
        profileId: profile?.id || null,
        scopeKey: plan.scopeKey,
        replacesActivitySnapshot:
          plan.regions.length === defaultPlan.regions.length
          && plan.regions.every((region, index) => region.id === defaultPlan.regions[index]?.id)
          && plan.feeMin === defaultPlan.feeMin
          && plan.feeMax === defaultPlan.feeMax
          && plan.targetPerRegion === defaultPlan.targetPerRegion
          && (plan.subActivityValues?.length || 0) === 0
          && plan.platformStatuses?.length === 1
          && plan.platformStatuses[0] === defaultPlan.platformStatuses[0],
      },
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
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
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
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && pathname === "/catalog/activities") {
      return send(response, 200, { activities: repository.listActivityCatalog() });
    }
    if (request.method === "GET" && pathname === "/search-profiles") {
      return send(response, 200, { profiles: repository.listSearchProfiles() });
    }
    if (request.method === "POST" && pathname === "/search-profiles") {
      const body = await readJsonBody(request);
      const profile = repository.createSearchProfile(body);
      return send(response, 201, { profile });
    }
    if (request.method === "PUT" && pathname.startsWith("/search-profiles/")) {
      const id = decodeURIComponent(pathname.slice("/search-profiles/".length));
      if (!id || id.includes("/")) return send(response, 400, { error: "INVALID_PROFILE", message: "معرف ملف البحث غير صالح." });
      const body = await readJsonBody(request);
      const profile = repository.updateSearchProfile(id, body);
      if (!profile) return send(response, 404, { error: "PROFILE_NOT_FOUND", message: "ملف البحث غير موجود." });
      return send(response, 200, { profile });
    }
    if (request.method === "GET" && request.url === "/health") {
      return send(response, 200, {
        online: true,
        serviceVersion,
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
      const enabledProfile = repository.getEnabledSearchProfile();
      const result = {
        lastSyncAt: previous.lastSyncAt || new Date().toISOString(),
        checked: previous.checked || previous.items.length,
        regions: previous.regions || defaultPlan.regions.length,
        targetPerRegion: previous.targetPerRegion || defaultPlan.targetPerRegion,
        added: [],
        changed: [],
        items: previous.items.filter((item) => item.reference).map((item) => ({ ...item, reference: item.reference || item.id })),
        scope: { activity: enabledProfile?.activityName || defaultPlan.activityName, maximumBookletFee: enabledProfile?.feeMax ?? defaultPlan.feeMax },
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
    if (request.method === "POST" && request.url === "/details/batch") {
      const body = await readJsonBody(request);
      const references = [...new Set((body.references || []).map((value) => String(value).trim()).filter(Boolean))];
      if (!references.length || references.length > 3) {
        return send(response, 400, { error: "INVALID_SAMPLE", message: "عينة التفاصيل يجب أن تتراوح بين منافسة واحدة وثلاث منافسات." });
      }
      const results = [];
      for (const reference of references) results.push(await inspectTenderDetails(reference));
      return send(response, 200, { inspected: results.length, results, downloaded: false, purchased: false });
    }
    if (request.method === "GET" && request.url === "/details/status") {
      return send(response, 200, repository.getDetailsStats());
    }
    if (request.method === "POST" && pathname === "/approval-intents") {
      // الطلب المعلق يثبت النطاق فقط ولا يمنح صلاحية تنزيل.
      const body = await readJsonBody(request);
      const intent = repository.requestDownloadApprovalIntent({
        tenderReference: String(body.tenderReference || ""),
        files: Array.isArray(body.files) ? body.files : [],
      });
      return send(response, 201, {
        intent,
        liveExecutionEnabled: false,
        message: "أُنشئ طلب معلق مرتبط بقائمة الملفات؛ لا توجد موافقة بعد.",
      });
    }
    if (request.method === "POST" && pathname.startsWith("/approval-intents/") && pathname.endsWith("/confirm")) {
      const allowedOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
      if (!allowedOrigins.has(String(request.headers.origin || ""))) {
        return send(response, 403, { error: "HUMAN_CONFIRMATION_ORIGIN_REQUIRED", message: "تأكيد الموافقة متاح من واجهة الرادار المحلية فقط." });
      }
      const id = decodeURIComponent(pathname.slice("/approval-intents/".length, -"/confirm".length));
      if (!id || id.includes("/")) return send(response, 400, { error: "INVALID_APPROVAL_INTENT", message: "معرف طلب الموافقة غير صالح." });
      const body = await readJsonBody(request);
      const approval = repository.confirmDownloadApprovalIntent(id, {
        consentText: String(body.consentText || ""),
        purchaseConfirmed: body.purchaseConfirmed === true,
      });
      return send(response, 201, {
        approval,
        liveExecutionEnabled: false,
        message: "سُجلت الموافقة لمدة 10 دقائق ولاستخدام واحد. لم تُستهلك لأن التنفيذ الحي غير مفعّل في P3-B0.",
      });
    }
    if (request.method === "POST" && pathname === "/approval-jobs") {
      // في B0 يفشل المحوّل قبل استهلاك الموافقة؛ لا تُهدر الموافقة بسبب محوّل معطّل.
      const body = await readJsonBody(request);
      const approval = repository.getDownloadApproval(String(body.approvalId || ""));
      if (!approval) {
        const error = new Error("الموافقة غير موجودة.");
        error.code = "APPROVAL_NOT_FOUND";
        throw error;
      }
      const job = repository.recordDownloadJob({
        approvalId: approval.id,
        tenderReference: approval.tenderReference,
        manifest: approval.scope,
        status: "running",
      });
      try {
        await downloadAdapter.execute({ id: job.id, manifest: approval.scope });
        const finished = repository.updateDownloadJob(job.id, { status: "complete", finished: true });
        return send(response, 200, { job: finished });
      } catch (adapterError) {
        const blocked = repository.updateDownloadJob(job.id, {
          status: "blocked",
          errorMessage: adapterError?.code || "DOWNLOAD_ADAPTER_DISABLED",
          finished: true,
        });
        return send(response, 409, {
          job: blocked,
          adapter: downloadAdapter.kind,
          error: adapterError?.code || "DOWNLOAD_ADAPTER_DISABLED",
          message: "بوابة الموافقة تعمل وسُجلت الوظيفة؛ التنفيذ الحي غير مفعّل في P3-B0.",
        });
      }
    }
    if (request.method === "GET" && pathname === "/approval-jobs") {
      return send(response, 200, { jobs: repository.listDownloadJobs() });
    }
    if (request.method === "POST" && request.url === "/sync") {
      if (!syncPromise) syncPromise = performSync().finally(() => { syncPromise = undefined; });
      const result = await syncPromise;
      return send(response, 200, result);
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const status = ["TENDER_NOT_FOUND", "APPROVAL_NOT_FOUND", "APPROVAL_INTENT_NOT_FOUND"].includes(error?.code) ? 404
      : ["INVALID_PROFILE", "INVALID_AVAILABILITY", "INVALID_DOWNLOAD_REQUEST", "BATCH_LIMIT_EXCEEDED",
        "EXTENSION_NOT_ALLOWED", "FILE_NOT_LISTED", "AVAILABILITY_NOT_ALLOWED", "CONSENT_REQUIRED",
        "PURCHASE_CONFIRMATION_REQUIRED", "FILE_TOO_LARGE", "BATCH_TOO_LARGE",
        "INVALID_TENDER_REFERENCE", "INVALID_STORAGE_PATH"].includes(error?.code) ? 400
      : ["APPROVAL_EXPIRED", "APPROVAL_CONSUMED", "APPROVAL_REVOKED", "APPROVAL_SCOPE_MISMATCH",
        "APPROVAL_INTENT_EXPIRED", "APPROVAL_INTENT_USED"].includes(error?.code) ? 409
      : ["LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "SESSION_NOT_OPEN"].includes(error?.code) ? 409 : 500;
    const phase = error?.code === "CAPTCHA_REQUIRED" ? "captcha-required"
      : ["LOGIN_REQUIRED", "SESSION_NOT_OPEN"].includes(error?.code) ? "login-required"
      : "error";
    const affectsRadarOperation = pathname === "/sync" || pathname === "/session" || pathname.startsWith("/details");
    if (affectsRadarOperation) {
      state = { ...state, phase, message: error?.message || "تعذر تنفيذ المزامنة", progress: repository.getSyncProgress() };
    }
    return send(response, status, {
      error: error?.code || "REQUEST_FAILED",
      message: error?.message || "تعذر تنفيذ الطلب",
      ...(affectsRadarOperation ? { state } : {}),
    });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Etimad sync service: http://127.0.0.1:${port}`));

function shutdown() {
  repository.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
