import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Arabic tender radar", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>رادار المنافسات \| البحث والتحليل<\/title>/);
  assert.match(html, /رادار المنافسات/);
  assert.match(html, /مركز المزامنة المستقلة/);
  assert.match(html, /زر واحد، بلا وسيط/);
  assert.match(html, /فتح جلسة اعتماد/);
  assert.match(html, /مزامنة الآن/);
  assert.match(html, /n8n يستقبل ويسجّل التغييرات/);
  assert.match(html, /اختبار ربط n8n/);
  assert.doesNotMatch(html, /اطلب مني الفحص/);
});

test("keeps independent sync local and credential-free", async () => {
  const [page, service, launcher, ignore] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-radar.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.match(page, /http:\/\/127\.0\.0\.1:4318/);
  assert.match(page, /\/session/);
  assert.match(page, /\/sync/);
  assert.match(service, /launchPersistentContext/);
  assert.match(service, /ConditionaBookletRange/);
  assert.match(service, /targetPerRegion: 100/);
  assert.doesNotMatch(service, /password|username|otp/i);
  assert.match(launcher, /etimad-sync-service\.mjs/);
  assert.match(ignore, /\.radar-data/);
});
