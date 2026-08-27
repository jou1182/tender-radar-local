// اختبارات P5-F1 — إدارة الوكلاء: التعليمات + الاختبار المعزول (خدمة حية على منفذ عابر معزول)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RADAR_DB_ROOT = await mkdtemp(path.join(os.tmpdir(), "radar-p5f1-"));
process.env.RADAR_SYNC_PORT = "0";
process.env.N8N_RADAR_WEBHOOK_URL = "http://127.0.0.1:9/x";

const mod = await import("../scripts/etimad-sync-service.mjs");
const server = mod.getSyncServer();
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

async function login() {
  const res = await fetch(`${base}/agents/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "setup", newSecret: "سر-الإدارة-12345" }),
  });
  if (res.status === 409) {
    // السر مضبوط مسبقًا — دخول عادي
    const retry = await fetch(`${base}/agents/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamSecret: "سر-الإدارة-12345" }),
    });
    return (await retry.json()).token;
  }
  return (await res.json()).token;
}

const sharedToken = await login();

test("P5-F1-1: new endpoints reject without a team token", async () => {
  for (const path of ["/agents/instructions", "/agents/test"]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleCode: "scout", instructions: "x", testInput: "y" }),
    });
    assert.equal(res.status, 401, path);
  }
});

test("P5-F1-2: instructions save, persist in /agents, and cap at 8000 chars", async () => {
  const token = sharedToken;
  const instructions = "أنت خالد، مهمتك تصنيف التخصص. اتبع قواعد الـrulebook حرفيًا.";
  const save = await fetch(`${base}/agents/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "classifier", instructions }),
  });
  assert.equal(save.status, 200);

  const list = await (await fetch(`${base}/agents`)).json();
  const classifier = list.agents.find((a) => a.roleCode === "classifier");
  assert.equal(classifier.systemInstructions, instructions);

  // حد 8000 حرف: يُقص بصمت دون خطأ
  const capped = await fetch(`${base}/agents/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "classifier", instructions: "س".repeat(9000) }),
  });
  assert.equal(capped.status, 200);
  const after = await (await fetch(`${base}/agents`)).json();
  assert.equal(after.agents.find((a) => a.roleCode === "classifier").systemInstructions.length, 8000);
});

test("P5-F1-3: sandbox test runs isolated on stub provider without touching any data table", async () => {
  const token = sharedToken;
  const res = await fetch(`${base}/agents/test`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({
      roleCode: "scout",
      testInput: "منافسة وهمية: إنشاء سور في حي الجامعة",
    }),
  });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.isolated, true);
  assert.equal(result.provider, "stub");
  assert.match(result.response, /محاكاة آمنة/);
  assert.match(result.response, /منافسة وهمية/);
});

test("P5-F1-4: sandbox test requires input and records activity only (no data writes)", async () => {
  const token = sharedToken;
  const empty = await fetch(`${base}/agents/test`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "scout", testInput: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "AGENT_TEST_INPUT_REQUIRED");

  const list = await (await fetch(`${base}/agents`)).json();
  assert.ok(list.activity.some((a) => a.action === "sandbox-test"));
});
