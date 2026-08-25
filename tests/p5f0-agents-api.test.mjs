// اختبارات P5-F0 — تكامل مسارات /agents عبر الخدمة الفعلية (منفذ عابر معزول)
// لا يمس خدمة 4318 الحية ولا قاعدة التشغيل: RADAR_SYNC_PORT=0 + RADAR_DB_ROOT معزول.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p5f0-svc-"));
process.env.RADAR_DB_ROOT = isolatedRoot;
process.env.RADAR_SYNC_PORT = "0"; // منفذ عابر يختاره النظام
process.env.N8N_RADAR_WEBHOOK_URL = "http://127.0.0.1:9/unreachable";

const serviceMod = await import("../scripts/etimad-sync-service.mjs");
const server = serviceMod.getSyncServer();

// انتظار استماع الخادم فعليًا (الاستيراد يعيد قبل اكتمال listen).
await new Promise((resolve, reject) => {
  if (server.listening) return resolve();
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

test.after(() => {
  return new Promise((resolve) => server.close(resolve));
});

test("P5-F0-API-1: GET /agents lists the seven default agents without auth", async () => {
  const res = await fetch(`${base}/agents`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.agents.length, 7);
  const names = data.agents.map((a) => a.nameAr);
  for (const expected of ["يوسف", "عبدالله", "مريم", "خالد", "نورة", "فهد", "سديم"]) {
    assert.ok(names.includes(expected), `expected ${expected}`);
  }
});

test("P5-F0-API-2: admin endpoints reject without a team token (401)", async () => {
  const res = await fetch(`${base}/agents/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleCode: "scout", nameAr: "مخترق" }),
  });
  assert.equal(res.status, 401);
});

test("P5-F0-API-3: setup -> token -> rename persists and activity is recorded", async () => {
  // ضبط كلمة سر الفريق أول مرة
  const setup = await fetch(`${base}/agents/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "setup", newSecret: "سر-قوي-12345" }),
  });
  assert.equal(setup.status, 200);
  const { token } = await setup.json();

  // إعادة تسمية يوسف
  const rename = await fetch(`${base}/agents/update`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "scout", nameAr: "سالم" }),
  });
  assert.equal(rename.status, 200);

  // الاسم الجديد ظاهر في القائمة العامة
  const list = await (await fetch(`${base}/agents`)).json();
  const scout = list.agents.find((a) => a.roleCode === "scout");
  assert.equal(scout.nameAr, "سالم");

  // سجل النشاط يسجل التعديل
  assert.ok(list.activity.some((item) => item.agent_role_code === "scout" && item.action === "profile-updated"));

  // ربط محلي Ollama يعمل؛ ورفض ربط خارجي دون تأكيد
  const bindLocal = await fetch(`${base}/agents/binding`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "analyst", binding: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nemotron-3.5-lightning:latest" } }),
  });
  assert.equal(bindLocal.status, 200);
  const bindExternal = await fetch(`${base}/agents/binding`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "analyst", binding: { provider: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "gpt" } }),
  });
  assert.equal(bindExternal.status, 400);
  assert.equal((await bindExternal.json()).error, "AGENT_EXTERNAL_CONFIRMATION_REQUIRED");
});
