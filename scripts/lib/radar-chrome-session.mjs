import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const defaultChromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function endpointReady(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(endpoint, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await endpointReady(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function createRadarChromeSession({ privateDir, startUrl, chromePath = process.env.RADAR_CHROME_PATH || defaultChromePath, debuggingPort = Number(process.env.RADAR_CHROME_PORT || 9333) }) {
  const profileDir = path.join(privateDir, "etimad-human-chrome-profile");
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  let browser;
  let launchedProcess;

  async function openForHumanLogin() {
    await mkdir(profileDir, { recursive: true });
    if (!(await endpointReady(endpoint))) {
      launchedProcess = spawn(chromePath, [
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${profileDir}`,
        "--start-maximized",
        "--disable-features=Translate",
        startUrl,
      ], { detached: true, stdio: "ignore", windowsHide: false });
      launchedProcess.unref();
      if (!(await waitForEndpoint(endpoint))) {
        throw new Error("تعذر فتح Chrome المخصص للرادار. أغلق نافذة الرادار القديمة ثم أعد المحاولة.");
      }
    } else {
      const opener = spawn(chromePath, [`--user-data-dir=${profileDir}`, startUrl], { detached: true, stdio: "ignore", windowsHide: false });
      opener.unref();
    }
    return { opened: true, mode: "human-chrome-cdp", profileDir, endpoint };
  }

  async function connect() {
    if (!(await endpointReady(endpoint))) {
      const error = new Error("افتح جلسة اعتماد من الرادار وسجّل الدخول بنفسك، ثم اضغط استئناف المزامنة.");
      error.code = "SESSION_NOT_OPEN";
      throw error;
    }
    if (!browser?.isConnected()) browser = await chromium.connectOverCDP(endpoint);
    return browser;
  }

  async function getEtimadPage({ navigate = true } = {}) {
    const connectedBrowser = await connect();
    const context = connectedBrowser.contexts()[0];
    const pages = context.pages();
    let page = pages.find((candidate) => candidate.url().includes("tenders.etimad.sa/Tender/AllSuppliersTenders"));
    if (!page) page = pages.find((candidate) => candidate.url().includes("etimad.sa"));
    if (!page) page = context.pages()[0] ?? await context.newPage();
    if (navigate && !page.url().includes("tenders.etimad.sa/Tender/AllSuppliersTenders")) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.bringToFront();
    return page;
  }

  function status() {
    return { mode: "human-chrome-cdp", connected: Boolean(browser?.isConnected()), endpoint, profileDir };
  }

  return { openForHumanLogin, getEtimadPage, status };
}
