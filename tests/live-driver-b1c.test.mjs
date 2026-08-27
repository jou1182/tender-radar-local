// اختبارات P3-B1C — سائق التنزيل الحي عبر CDP: fixtures بلا Chrome حقيقي
// نستبدل fetchVersionAndTarget و WebSocket بمحاكاة خادم CDP محلي + WS وهمي.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

process.env.RADAR_DB_ROOT = await mkdtemp(path.join(os.tmpdir(), "radar-b1c-"));

const driverModule = await import("../scripts/lib/etimad-live-driver.mjs");
const acquisition = await import("../scripts/lib/live-attachment-acquisition.mjs");
const { createEtimadLiveDriver } = driverModule;
const { createLiveDownloadAdapter, assertLivePreconditions, assertSafeDownloadTrigger, inspectQuarantinedFile } = acquisition;
const gate = await import("../scripts/lib/download-gate.mjs");
const repoMod = await import("../scripts/lib/radar-repository.mjs");

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("radar-test-bytes".repeat(40))]);

// ── محاكاة CDP: خادم HTTP يجيب /json/version و /json/list، وخادم WS يتصرف كصفحة ──
const cdpPort = 9700;
let downloadDirRef = { dir: null };
let clickResult = "CLICKED";
let pageUrl = "https://tenders.etimad.sa/Tender/Details/260839005042";

const httpServer = createServer((req, res) => {
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "chrome-sim/1.0" }));
  } else if (req.url === "/json/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "page-sim", type: "page", url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/page` }]));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server: httpServer, path: "/page" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const { id, method, params } = JSON.parse(raw);
    if (method === "Page.navigate") {
      ws.send(JSON.stringify({ id, result: {} }));
      return;
    }
    if (method === "Page.setDownloadBehavior") {
      downloadDirRef.dir = params.downloadPath;
      ws.send(JSON.stringify({ id, result: {} }));
      return;
    }
    if (method === "Runtime.evaluate") {
      const expr = String(params.expression ?? "");
      if (expr.includes("CLICKED") || expr.includes("NO_MATCH")) {
        // طلب النقر — حلّل ما إذا كنا نسمح بالنقر أم نرفض
        if (clickResult === "CLICKED") {
          ws.send(JSON.stringify({ id, result: { result: { value: "CLICKED" } } }));
          // بدء "تنزيل": اكتب ملفًا في مجلد التنزيل الموجه — PDF حقيقي البنية
          setTimeout(async () => {
            try {
              await mkdir(downloadDirRef.dir, { recursive: true });
              // أولاً .crdownload جزئي ثم مكتمل
              await writeFile(path.join(downloadDirRef.dir, "attachment.pdf.crdownload"), PDF.subarray(0, 100));
              setTimeout(async () => {
                await writeFile(path.join(downloadDirRef.dir, "attachment.pdf"), PDF);
                await rm(path.join(downloadDirRef.dir, "attachment.pdf.crdownload"), { force: true });
              }, 350);
            } catch (e) { console.error("[sim write err]", e.message); }
          }, 250);
        } else {
          ws.send(JSON.stringify({ id, result: { result: { value: "NO_MATCH" } } }));
        }
        return;
      }
      // طلب preflight — المحاكاة تطابق دائمًا (سلوك الصفحة الحقيقية بعد رصد المرفق)
      const matched = true;
      ws.send(JSON.stringify({
        id,
          result: { result: { value: JSON.stringify(matched ? {
            url: pageUrl, ready: "complete",
            match: { tag: "A", text: "كراسة الشروط والمواصفات", aria: "تنزيل كراسة", title: "", href: "/Download/attachment.pdf", rect: { x: 10, y: 10, w: 100, h: 30 } },
          } : { url: pageUrl, ready: "complete", match: null }) } },
      }));
      return;
    }
    ws.send(JSON.stringify({ id, result: {} }));
  });
});

test.before(async () => {
  await new Promise((r) => httpServer.listen(cdpPort, "127.0.0.1", r));
});

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "b1c-proj-"));
const privateDir = path.join(projectRoot, ".radar-data");
const repository = (await repoMod.createRadarRepository({ projectRoot }));

function seedTender(fee) {
  repository.saveCompletedSync({
    startedAt: "2026-08-28T00:00:00Z", finishedAt: "2026-08-28T00:01:00Z", lastSyncAt: "2026-08-28T00:01:00Z", regions: 13, checked: 315, added: [], changed: [],
    targetPerRegion: 100,
    items: [{
      reference: "260839005042", title: "منافسة اختبار السائق", agency: "جهة", fee,
      region: "منطقة القصيم", deadline: "2026-09-10", publishedAt: "2026-08-20",
      platformStatus: "المنافسات النشطة (تقديم العروض)", activity: "المقاولات", subActivity: "مباني",
      tenderType: "منافسة عامة", etimadUrl: "https://tenders.etimad.sa/Tender/Details/260839005042",
      tenderNumber: "", contractDuration: "", guarantee: "", location: "", quantitySummary: "",
      remoteAttachments: ["كراسة الشروط والمواصفات.pdf"],
    }],
  }, "run-b1c-seed");
  repository.setAttachmentAvailability("260839005042", "كراسة الشروط والمواصفات.pdf", "purchased-available", { requiresApproval: true });
  return repository.listAttachmentMeta("260839005042");
}

function liveEnv(approval) {
  return {
    RADAR_LIVE_DOWNLOAD_ENABLED: "true",
    RADAR_LIVE_DOWNLOAD_TENDER_REF: "260839005042",
    RADAR_LIVE_DOWNLOAD_FILE_NAME: "كراسة الشروط والمواصفات.pdf",
    RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256: gate.hashDownloadManifest(approval.scope),
  };
}

function createAdapter(repo, approval, envOverride = {}) {
  const driver = createEtimadLiveDriver({ cdpPort, downloadPollMs: 60 });
  return createLiveDownloadAdapter({
    repository: repo, projectRoot, privateDir,
    env: { ...liveEnv(approval), ...envOverride },
    driver,
    timeoutMs: 8_000, preflightTimeoutMs: 5_000,
  });
}

test.after(async () => {
  repository.close();
  httpServer.close();
});

test("B1C-1: driver preflight finds matching element on simulated page", async () => {
  const driver = createEtimadLiveDriver({ cdpPort: cdpPort });
  const target = await driver.preflight({
    tender: { reference: "260839005042" },
    trustedTenderUrl: "https://tenders.etimad.sa/Tender/Details/260839005042",
    displayName: "كراسة الشروط والمواصفات.pdf",
  });
  assert.equal(target.ready, true);
  assert.equal(target.tenderReference, "260839005042");
  assert.ok(target.targetId);
  assert.match(target.elementInfo.text, /كراسة/);
});

test("B1C-2: full live flow — paid tender (200) downloads, inspects, and stores atomically", async () => {
  const metas = seedTender(200);
  const meta = assertLivePreconditions({
    tender: { attachmentsMeta: metas },
    displayName: "كراسة الشروط والمواصفات.pdf",
  });
  assert.equal(meta.displayName, "كراسة الشروط والمواصفات.pdf");

  const intent = repository.requestDownloadApprovalIntent({
    tenderReference: "260839005042",
    files: [{ displayName: "كراسة الشروط والمواصفات.pdf" }],
  });
  const approved = repository.confirmDownloadApprovalIntent(intent.id, {
    consentText: "أوافق على تنزيل الملفات المحددة الآن من هذه المنافسة فقط",
  });
  assert.equal(approved.status, "approved");

  const adapter = createAdapter(repository, approved);
  const job = { id: "job-b1c-e2e", approvalId: approved.id, manifest: approved.scope };
  const result = await adapter.execute(job);

  assert.equal(result.status, "complete");
  assert.match(result.files[0], /260839005042/);
  const stored = await readFile(result.files[0]);
  assert.deepEqual(stored.subarray(0, 8), PDF.subarray(0, 8));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  const metasAfter = repository.listAttachmentMeta("260839005042");
  const downloaded = metasAfter.find((m) => m.displayName === "كراسة الشروط والمواصفات.pdf");
  assert.equal(downloaded.downloadStatus, "downloaded");
  assert.ok(downloaded.localPath);
});

test("B1C-3: unsafe element (purchase wording) is refused before click", () => {
  assert.throws(
    () => assertSafeDownloadTrigger({ text: "شراء كراسة الشروط" }),
    (e) => e.code === "LIVE_UNSAFE_ELEMENT",
  );
  assert.throws(
    () => assertSafeDownloadTrigger({ text: "تقديم عرض", href: "/BuyBooklet" }),
    (e) => e.code === "LIVE_UNSAFE_ELEMENT",
  );
  assert.doesNotThrow(() => assertSafeDownloadTrigger({ text: "تنزيل كراسة الشروط والمواصفات", href: "/Download/attachment.pdf" }));
});

test("B1C-4: quarantine inspection rejects mismatched MIME/signature", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "b1c-quar-"));
  const fake = path.join(dir, "doc.pdf");
  await writeFile(fake, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]));
  await assert.rejects(
    () => inspectQuarantinedFile({ quarantinePath: fake, displayName: "doc.pdf", contentType: "application/pdf" }),
    (e) => e.code === "LIVE_SIGNATURE_MISMATCH",
  );
  const good = path.join(dir, "good.pdf");
  await writeFile(good, PDF);
  const info = await inspectQuarantinedFile({ quarantinePath: good, displayName: "good.pdf", contentType: "application/pdf" });
  assert.equal(info.extension, "pdf");
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
});

test("B1C-5: driver refuses when human Chrome session is down", async () => {
  const driver = createEtimadLiveDriver({ cdpPort: 9222 + 300 + Math.floor(Math.random() * 100) });
  await assert.rejects(
    () => driver.preflight({ tender: { reference: "x" }, trustedTenderUrl: "https://tenders.etimad.sa/Tender/Details/x", displayName: "y" }),
    (e) => e.code === "LIVE_CDP_UNREACHABLE",
  );
});

test("B1C-6: env vars off = adapter disabled before anything (safety net intact)", async () => {
  const adapterOff = createLiveDownloadAdapter({
    repository, projectRoot, privateDir,
    env: {},
    driver: createEtimadLiveDriver({ cdpPort }),
  });
  await assert.rejects(
    () => adapterOff.execute({ id: "job-off", approvalId: "a", manifest: { tenderReference: "260839005042", files: [{ displayName: "كراسة الشروط والمواصفات.pdf" }] } }),
    (e) => e.code === "LIVE_ADAPTER_DISABLED",
  );
});
