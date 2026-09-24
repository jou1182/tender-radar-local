import http from "node:http";
import crypto from "node:crypto";
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
import { cardFeeEvidence, mergeSyncFeeEvidence } from "./lib/fee-evidence.mjs";
import { createLiveDownloadAdapter } from "./lib/live-attachment-acquisition.mjs";
import { createEtimadLiveDriver } from "./lib/etimad-live-driver.mjs";
import { truncateSourceWalAfterCompleteRun } from "./lib/db-maintenance.mjs";
import { classifyAndStoreTenders, loadRulebook as loadSpecialtyRulebook } from "./lib/specialty-classifier.mjs";
import { evaluateQueueForRun } from "./lib/attachment-queue-evaluator.mjs";
import {
  validateBinding,
  setTeamCredential,
  verifyTeamPassphrase,
  createSessionManager,
} from "./lib/agent-team.mjs";
import { runAgentSandboxTest } from "./lib/agent-sandbox.mjs";
import { computeAgentProfileChanges } from "./lib/agent-profile-change.mjs";
import { createDashboardApi } from "./lib/dashboard-api.mjs";
import { createAnalysisEngine } from "./lib/analysis-engine.mjs";
import { createAnalysisApiHandler } from "./lib/analysis-api.mjs";
import { attachmentStorageRoot } from "./lib/attachment-storage.mjs";
import { readJsonBodyLimited as readJsonBody } from "./lib/http-body.mjs";

// RADAR_DB_ROOT يوجّه قاعدة البيانات إلى مجلد معزول (لاختبارات التكامل) دون لمس قاعدة التشغيل.
const projectRoot = process.env.RADAR_DB_ROOT ? path.resolve(process.env.RADAR_DB_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.join(projectRoot, ".radar-data");
// baseline يُقرأ دائمًا من مجلد السكربتات الفعلي حتى لو وُجّهت قاعدة البيانات لمجلد معزول.
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = path.join(scriptRoot, "scripts", "sync-baseline.json");
const listUrl = "https://tenders.etimad.sa/Tender/AllSuppliersTenders?PageNumber=1";
const port = Number(process.env.RADAR_SYNC_PORT || 4318);
const serviceVersion = "p4a-local-analysis-1";
const localUiOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
const n8nWebhookUrl = process.env.N8N_RADAR_WEBHOOK_URL || "http://127.0.0.1:5678/webhook/radar-sync-5d354757-90d1-4dc3-b7f7-c93e4c50ecb1";
const repository = await createRadarRepository({ projectRoot });
const dashboardApi = createDashboardApi({ repository });
const baselineIds = JSON.parse(await readFile(baselineFile, "utf8"));
await loadSpecialtyRulebook(); // كاش قواعد تصنيف «خالد»
repository.seedBaseline(baselineIds);
const chromeSession = createRadarChromeSession({ privateDir, startUrl: listUrl });
// المحوّل الوحيد في P3-B0: أي محاولة تنفيذ حي تعيد DOWNLOAD_ADAPTER_DISABLED.
const downloadAdapter = createDisabledProductionDownloadAdapter();
// محوّل P3-B1A/B1C الحي المحكوم: معطل افتراضيًا بيئيًا ومقيد بقائمة سماح واحدة ومفتاح إيقاف فوري.
// P3-B1C: سائق Chrome البشري (CDP :9333) متصل الآن — يبقى خامًا حتى تفعيل env vars الثلاثة
// (ENABLED + TENDER_REF + FILE_NAME + MANIFEST_SHA256) وإلا فشل قبل استهلاك الموافقة.
const liveDriver = createEtimadLiveDriver({ cdpPort: Number(process.env.RADAR_LIVE_CDP_PORT ?? 9333) });
const liveAcquisitionAdapter = createLiveDownloadAdapter({ repository, projectRoot, privateDir, driver: liveDriver });
// محرك التحليل المحلي P4-A0: fixtures مغلقة فقط، Stub افتراضي، وOllama المحلي لا يعمل إلا بتفعيل صريح.
// المخزن الموثوق للمرفقات المحلية يوفّر مدخلًا ثانيًا ضيقًا: مستند موثق موجود فعلًا على القرص.
const analysisEngine = createAnalysisEngine({
  repository,
  fixtureRoot: path.join(projectRoot, "analysis-fixtures"),
  trustedStoreRoot: attachmentStorageRoot(projectRoot),
  env: process.env,
});
const handleAnalysisRequest = createAnalysisApiHandler({ engine: analysisEngine });

let syncPromise;
let liveDownloading = false; // P5-KEEPALIVE: علم تنزيل حي جارٍ — تقرؤه النبضة لقفل التشابك
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

async function extractCards(page, regionId) {
  const cards = await page.locator("div.card").evaluateAll((cardNodes, args) => cardNodes.map((card) => {
    const link = card.querySelector('h5 a[href*="/Tender/Details"]');
    if (!link) return null;
    const text = (card.innerText || "").replace(/\r/g, "");
    const reference = (text.match(/الرقم المرجعي\s*\n?\s*(\d{12})/) || [])[1] || "";
    const feeMatch = text.match(/قيمة (?:وثائق المنافسة|الكراسة)\s*[:：]?\s*([^\n]*)\n?([^\n]*)/);
    const feeText = feeMatch ? ((feeMatch[1] || "").trim() || (feeMatch[2] || "").trim()) : "";
    const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
    const headings = [...card.querySelectorAll("h5")].map((item) => (item.textContent || "").trim()).filter(Boolean);
    return {
      reference,
      title: (link.textContent || "").trim(),
      agency: headings[1] || "",
      feeText,
      publishedAt: dates[0] || "",
      deadline: dates[1] ? `${dates[1]} 09:59` : "",
      href: link.getAttribute("href") || "",
      regionId: args.regionId,
    };
  }).filter((item) => item?.reference), { regionId });
  return cards.map((card) => ({ ...card, ...cardFeeEvidence(card.feeText) }));
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
    feeVerification: item.feeVerification || "unknown",
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
    feeVerification: item.feeVerification || "unknown",
    feeRawText: item.feeRawText || null,
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

      const rawBatch = await extractCards(page, region.id);
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

    const rawItems = buildTenderItems(repository.loadDraftObservations(run.id), plan);
    const previousItems = repository.loadComparisonItems();
    const previousMap = new Map(previousItems.map((item) => [item.id, item]));
    const items = rawItems.map((item) => ({ ...item, ...mergeSyncFeeEvidence(previousMap.get(item.id), item) }));
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
    // P4-O0B: بعد جولة مكتملة فقط — اختصار الـWAL المصدر إن تجاوز العتبة؛
    // لا يفشل الجولة أبدًا (النتيجة تحمل walCheckpoint للشفافية).
    result.walCheckpoint = await truncateSourceWalAfterCompleteRun({
      databasePath: repository.databasePath,
      runStatus: "complete",
    });
    // نشاط وكيل الرصد «يوسف» — سجل حي لطاقم الوكلاء (P5-F0).
    try {
      repository.recordAgentActivity({
        roleCode: "scout",
        action: "sync-complete",
        status: "success",
        detail: { checked: result.checked, added: added.length, changed: changed.length },
      });
    } catch (activityError) {
      // نشاط الوكلاء لا يفشل الجولة أبدًا — يسجل كتحذير في سجل الخدمة فقط.
      console.warn("[agents] failed to record scout activity:", activityError);
    }
    // وكيل التصنيف «خالد» — حتمي بلا LLM؛ فشله لا يفشل الجولة.
    try {
      const classification = await classifyAndStoreTenders(repository, result.items);
      repository.recordAgentActivity({
        roleCode: "classifier",
        action: "classification-complete",
        status: "success",
        detail: { classified: classification.classified, skipped: classification.skipped },
      });
    } catch (classifierError) {
      console.warn("[agents] classifier pass failed:", classifierError);
      try {
        repository.recordAgentActivity({ roleCode: "classifier", action: "classification-complete", status: "error", detail: { message: String(classifierError?.message || classifierError).slice(0, 200) } });
      } catch (activityFailure) {
        console.warn("[agents] could not record classifier failure:", activityFailure);
      }
    }
    // وكيل التحميل «عبدالله» — يبني صفوف الطابور من المرفقات الظاهرة وفق السياسة.
    try {
      const queueSummary = evaluateQueueForRun(repository, result.items);
      repository.recordAgentActivity({
        roleCode: "courier",
        action: "queue-evaluated",
        status: "success",
        detail: { ...queueSummary },
      });
    } catch (queueError) {
      console.warn("[agents] queue evaluation failed:", queueError);
    }
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
    "Access-Control-Allow-Origin": response.radarCorsOrigin || "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    // P5-F1R: x-team-token إلزامي لواجهات الكتابة الموثّقة — بدون إدراجه هنا
    // يرفض المتصفح الـpreflight ويفشل كل حفظ من الواجهة (Failed to fetch).
    "Access-Control-Allow-Headers": "Content-Type, x-team-token",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

// قراءة جسم JSON تتم عبر readJsonBody المستوردة من lib/http-body.mjs — حد 64 ك.ب إلزامي.

// ── P5-F0: واجهة طاقم الوكلاء ─────────────────────────────────────────────────
// كلمة سر الفريق تُضبط أول مرة عبر /agents/auth (setup)؛ بعدها كل تعديل يتطلب توكنًا.
const teamSessions = createSessionManager({ secret: crypto.randomUUID() });

function requireTeamToken(request) {
  const token = String(request.headers["x-team-token"] || "");
  if (!teamSessions.verify(token)) {
    return false;
  }
  return true;
}

async function handleAgentsApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/agents") {
    const agents = repository.listAgents().map((agent) => ({
      roleCode: agent.role_code,
      nameAr: agent.name_ar,
      nameEn: agent.name_en,
      gender: agent.gender,
      color: agent.color,
      roleLabel: agent.role_label,
      enabled: agent.enabled,
      displayOrder: agent.display_order,
      provider: agent.binding?.provider || "stub",
      external: Boolean(agent.binding?.baseUrl && !/^http(s)?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(agent.binding.baseUrl)),
      systemInstructions: agent.system_instructions || "",
      updatedAt: agent.updated_at,
    }));
    return send(response, 200, { agents, activity: repository.listRecentAgentActivity(12) });
  }

  if (request.method === "POST" && pathname === "/agents/auth") {
    const body = await readJsonBody(request);
    try {
      if (body?.action === "setup") {
        setTeamCredential(repository, {
          newSecret: body.newSecret,
          currentSecret: body.currentSecret,
        });
        repository.recordAgentActivity({ roleCode: "sentinel", action: "team-credential-set", status: "info" });
        const { token, expiresAt } = teamSessions.issue();
        return send(response, 200, { ok: true, token, expiresAt });
      }
      if (!verifyTeamPassphrase(repository, body?.teamSecret)) {
        return send(response, 401, { error: "TEAM_CREDENTIAL_MISMATCH", message: "كلمة السر غير صحيحة." });
      }
      const { token, expiresAt } = teamSessions.issue();
      return send(response, 200, { ok: true, token, expiresAt });
    } catch (error) {
      const code = error?.code || "TEAM_AUTH_FAILED";
      return send(response, code === "TEAM_CREDENTIAL_NOT_SET" ? 409 : 400, { error: code, message: String(error?.message || error) });
    }
  }

  // كل ما بعد هذه النقطة إداري — يتطلب توكن فريق صالحًا.
  if (!requireTeamToken(request)) {
    return send(response, 401, { error: "TEAM_TOKEN_REQUIRED", message: "أدخل كلمة سر الفريق أولًا." });
  }

  if (request.method === "POST" && pathname === "/agents/update") {
    const body = await readJsonBody(request);
    const roleCode = String(body?.roleCode || "").trim();
    if (!roleCode) return send(response, 400, { error: "ROLE_REQUIRED", message: "معرف الدور مطلوب." });
    const before = repository.getAgentByRole(roleCode);
    if (!before) return send(response, 404, { error: "AGENT_NOT_FOUND", message: `وكيل غير معروف: ${roleCode}` });
    // P5-F1R: يُحسب ما تغيّر فعلًا قبل التحديث (الاسمان + حالة التشغيل + الترتيب)،
    // ليُعلن بصدق في الاستجابة وفي سجل النشاط — فلا تُقال «تم حفظ الاسم» بلا تغيير.
    const changed = computeAgentProfileChanges(before, body);
    try {
      repository.updateAgentProfile(roleCode, {
        nameAr: body.nameAr,
        nameEn: body.nameEn,
        enabled: body.enabled,
        displayOrder: body.displayOrder,
      });
      repository.recordAgentActivity({
        roleCode, action: "profile-updated", status: "info",
        detail: { changed, nameAr: body.nameAr ?? null, nameEn: body.nameEn ?? null, enabled: body.enabled ?? null },
      });
      return send(response, 200, { ok: true, changed, agent: repository.getAgentByRole(roleCode) });
    } catch (error) {
      // خطأ تحقق (اسم فارغ) ⇒ 400، وكيل مجهول ⇒ 404، وأي خلل غير متوقع ⇒ 500.
      const code = error?.code || "AGENT_UPDATE_FAILED";
      const status = code === "AGENT_NOT_FOUND" ? 404 : code === "AGENT_NAME_REQUIRED" ? 400 : 500;
      return send(response, status, { error: code, message: String(error?.message || error) });
    }
  }

  if (request.method === "POST" && pathname === "/agents/binding") {
    const body = await readJsonBody(request);
    const roleCode = String(body?.roleCode || "").trim();
    if (!roleCode) return send(response, 400, { error: "ROLE_REQUIRED", message: "معرف الدور مطلوب." });
    try {
      const binding = validateBinding(body.binding);
      repository.setAgentBinding(roleCode, binding);
      repository.recordAgentActivity({
        roleCode, action: "binding-updated", status: binding.provider === "stub" ? "info" : "success",
        detail: { provider: binding.provider, external: Boolean(binding.baseUrl && !binding.baseUrl.includes("127.0.0.1") && !binding.baseUrl.includes("localhost")) },
      });
      return send(response, 200, { ok: true, agent: repository.getAgentByRole(roleCode) });
    } catch (error) {
      const code = error?.code || "AGENT_BINDING_INVALID";
      return send(response, 400, { error: code, message: String(error?.message || error) });
    }
  }

  // ── P5-F1: حفظ تعليمات السلوك (يتطلب توكنًا) ──────────────────────────────
  if (request.method === "POST" && pathname === "/agents/instructions") {
    const body = await readJsonBody(request);
    const roleCode = String(body?.roleCode || "").trim();
    if (!roleCode) return send(response, 400, { error: "ROLE_REQUIRED", message: "معرف الدور مطلوب." });
    try {
      const agent = repository.setAgentInstructions(roleCode, body.instructions);
      repository.recordAgentActivity({
        roleCode, action: "instructions-updated", status: "info",
        detail: { length: String(body?.instructions ?? "").length },
      });
      return send(response, 200, { ok: true, agent });
    } catch (error) {
      return send(response, 404, { error: "AGENT_NOT_FOUND", message: String(error?.message || error) });
    }
  }

  // ── P5-F1: اختبار معزول للوكيل (يتطلب توكنًا) ─────────────────────────────
  // لا كتابة في أي جدول بيانات؛ فقط استدعاء مزود الوكيل (أو محاكاة stub) وإرجاع الاستجابة.
  if (request.method === "POST" && pathname === "/agents/test") {
    const body = await readJsonBody(request);
    const roleCode = String(body?.roleCode || "").trim();
    if (!roleCode) return send(response, 400, { error: "ROLE_REQUIRED", message: "معرف الدور مطلوب." });
    try {
      const agent = repository.getAgentByRole(roleCode);
      if (!agent) return send(response, 404, { error: "AGENT_NOT_FOUND", message: "الوكيل غير موجود." });
      const result = await runAgentSandboxTest({
        agent,
        teamSecret: body.teamSecret,
        testInput: body.testInput,
      });
      repository.recordAgentActivity({
        roleCode, action: "sandbox-test", status: "info",
        detail: { provider: result.provider, inputLength: String(body?.testInput ?? "").length },
      });
      return send(response, 200, { ok: true, result });
    } catch (error) {
      const code = error?.code || "AGENT_TEST_FAILED";
      return send(response, 400, { error: code, message: String(error?.message || error) });
    }
  }

  return send(response, 404, { error: "NOT_FOUND", message: `مسار غير معروف: ${pathname}` });
}

const server = http.createServer(async (request, response) => {
  // P5-F1R: يُصدَّر أصل الواجهة كما جاء إن كان محليًا معروفًا (localhost أو 127.0.0.1)؛
  // وإلا يبقى الافتراضي. كان مثبّتًا على http://localhost:3000 فتتعطّل كل الكتابات
  // عند فتح التطبيق عبر 127.0.0.1:3000 بنفس عطل CORS الذي أُصلح اليوم.
  const requestOrigin = String(request.headers.origin || "");
  response.radarCorsOrigin = localUiOrigins.has(requestOrigin) ? requestOrigin : "http://localhost:3000";
  if (request.method === "OPTIONS") return send(response, 204, {});
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    // ── P5-F0: مسارات طاقم الوكلاء ──────────────────────────────────────────
    // عام: قراءة الطاقم وحالته وآخر النشاط. إداري: يتطلب X-Team-Token.
    if (pathname === "/agents" || pathname.startsWith("/agents/")) {
      return handleAgentsApi(request, response, pathname);
    }
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
    if (request.method === "GET" && request.url === "/status") return send(response, 200, { ...state, progress: repository.getSyncProgress(), downloading: liveDownloading, syncing: syncPromise != null });
    // ── P5-KEEPALIVE: قراءة/ضبط فترة نبضة إبقاء جلسة اعتماد ────────────────────
    if (request.method === "GET" && request.url === "/keepalive/interval") {
      return send(response, 200, {
        keepaliveIntervalSeconds: repository.getKeepaliveInterval(),
        limits: { min: 30, max: 300 },
      });
    }
    if (request.method === "POST" && request.url === "/keepalive/interval") {
      const body = await readJsonBody(request);
      try {
        return send(response, 200, repository.setKeepaliveInterval(Number(body.keepaliveIntervalSeconds)));
      } catch (error) {
        return send(response, 400, { error: error?.code || "KEEPALIVE_INTERVAL_INVALID", message: String(error?.message || error) });
      }
    }
    // ── P5-DASH: لوحة رؤى الجولة والمناطق والتخزين ──────────────────────────────
    if (request.method === "GET" && request.url === "/dashboard/last-run") {
      const summary = dashboardApi.lastRunSummary();
      if (!summary) return send(response, 200, { available: false, message: "لم تكتمل مزامنة حقيقية بعد." });
      return send(response, 200, { available: true, ...summary });
    }
    if (request.method === "GET" && request.url === "/dashboard/regions") {
      return send(response, 200, dashboardApi.regionStats());
    }
    if (request.method === "GET" && request.url === "/dashboard/storage") {
      return send(response, 200, dashboardApi.attachmentsOverview());
    }
    // مسح المرفقات الأقدم من N يومًا — استباقي (dryRun) أو فعلي مع تأكيد صريح.
    if (request.method === "POST" && request.url === "/dashboard/storage/purge") {
      const body = await readJsonBody(request).catch(() => ({}));
      const olderThanDays = Math.min(365, Math.max(1, Number(body?.olderThanDays ?? 30)));
      const dryRun = !body?.confirm;
      const result = repository.purgeOldAttachments({ olderThanDays, dryRun });
      if (!dryRun) repository.recordAgentActivity({ roleCode: "courier", action: "storage-purge", status: "info", detail: { deleted: result.deleted, freedBytes: result.freedBytes, olderThanDays } });
      return send(response, 200, result);
    }
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
      if (!localUiOrigins.has(String(request.headers.origin || ""))) {
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
    if (request.method === "POST" && pathname === "/approval-jobs/live") {
      // P5-SYNCLIVE: قفل تشابك متبادل — لا يبدأ تنزيل حي بينما مزامنة نشطة.
      // (الاتجاه المعاكس محروس في /sync أعلاه.)
      if (syncPromise) {
        return send(response, 409, { error: "LIVE_DOWNLOAD_BLOCKED_BY_SYNC", message: "مزامنة نشطة حاليًا — انتظر اكتمالها ثم أعد طلب التنزيل." });
      }
      // مسار P3-B1A: المحوّل الحي المحكوم يتحقق من قائمة السماح والحواجز، ولا يستهلك الموافقة وهو معطل.
      if (!localUiOrigins.has(String(request.headers.origin || ""))) {
        return send(response, 403, { error: "HUMAN_CONFIRMATION_ORIGIN_REQUIRED", message: "بدء التجربة متاح من واجهة الرادار المحلية فقط." });
      }
      // P5-SYNCLIVE (TOCTOU): رفعُ العلم متزامنٌ قبل أول await — لا تنفتح نافذة
      // للتزامن (أو تنزيلٍ ثانٍ) بين فحص الحارس وبدء التنفيذ. إعادة الضبط في
      // finally أدناه تغطي كل المسارات بما فيها APPROVAL_NOT_FOUND وقراءة الجسد.
      liveDownloading = true;
      try {
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
          const result = await liveAcquisitionAdapter.execute({ id: job.id, approvalId: approval.id, manifest: approval.scope });
          const finished = repository.updateDownloadJob(job.id, { status: "complete", finished: true });
          return send(response, 200, { job: finished, result, adapter: liveAcquisitionAdapter.kind });
        } catch (adapterError) {
          const guarded = adapterError?.code === "LIVE_ADAPTER_DISABLED"
            || adapterError?.code === "LIVE_DRIVER_NOT_CONFIGURED"
            || adapterError?.code === "LIVE_ALLOWLIST_MISMATCH"
            || adapterError?.code === "LIVE_PRECHECK_FAILED"
            || adapterError?.code === "LIVE_UNTRUSTED_URL"
            || adapterError?.code === "LIVE_TARGET_MISMATCH"
            || String(adapterError?.code || "").startsWith("APPROVAL_");
          const updated = repository.updateDownloadJob(job.id, {
            status: guarded ? "blocked" : "failed",
            errorMessage: adapterError?.code || "LIVE_DOWNLOAD_FAILED",
            finished: true,
          });
          return send(response, guarded ? 409 : 500, {
            job: updated,
            adapter: liveAcquisitionAdapter.kind,
            error: adapterError?.code || "LIVE_DOWNLOAD_FAILED",
            message: adapterError?.message || "تعذر تنفيذ التنزيل الحي المحكوم؛ لا إعادة محاولة تلقائية.",
          });
        }
      } finally {
        liveDownloading = false;
      }
    }
    if (request.method === "POST" && request.url === "/sync") {
      // P5-SYNCLIVE: قفل تشابك متبادل — لا تبدأ مزامنة بينما تنزيل حي جارٍ.
      // (الاتجاه المعاكس محروس في /approval-jobs/live أدناه.)
      if (liveDownloading) {
        return send(response, 409, { error: "SYNC_BLOCKED_BY_LIVE_DOWNLOAD", message: "تنزيل حي نشط حاليًا — انتظر اكتماله ثم أعد المزامنة." });
      }
      if (!syncPromise) syncPromise = performSync().finally(() => { syncPromise = undefined; });
      const result = await syncPromise;
      return send(response, 200, result);
    }
    // P4-A0: نقاط التحليل المحلي — معزولة تمامًا عن مسارات المزامنة والتنزيل أعلاه.
    if (pathname === "/analysis/health" || pathname === "/analysis/jobs" || pathname.startsWith("/analysis/jobs/")) {
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const handled = await handleAnalysisRequest({ method: request.method, pathname, body });
      if (handled) return send(response, handled.status, handled.payload);
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const status = error?.code === "REQUEST_BODY_TOO_LARGE" ? 413
      : ["TENDER_NOT_FOUND", "APPROVAL_NOT_FOUND", "APPROVAL_INTENT_NOT_FOUND"].includes(error?.code) ? 404
      : ["INVALID_PROFILE", "INVALID_AVAILABILITY", "INVALID_DOWNLOAD_REQUEST", "BATCH_LIMIT_EXCEEDED",
        "EXTENSION_NOT_ALLOWED", "FILE_NOT_LISTED", "AVAILABILITY_NOT_ALLOWED", "CONSENT_REQUIRED",
        "PURCHASE_CONFIRMATION_REQUIRED", "FILE_TOO_LARGE", "BATCH_TOO_LARGE",
        "INVALID_TENDER_REFERENCE", "INVALID_STORAGE_PATH"].includes(error?.code) ? 400
      : ["APPROVAL_EXPIRED", "APPROVAL_CONSUMED", "APPROVAL_REVOKED", "APPROVAL_SCOPE_MISMATCH",
        "APPROVAL_INTENT_EXPIRED", "APPROVAL_INTENT_USED", "FEE_NOT_DETAIL_VERIFIED"].includes(error?.code) ? 409
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

// يُصدَّر لأغراض اختبارات التكامل المعزولة (إغلاق نظيف + معرفة المنفذ الفعلي).
export function getSyncServer() {
  return server;
}

function shutdown() {
  repository.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
