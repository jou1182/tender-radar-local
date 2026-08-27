// اختبارات P5-F2 — تغيير كلمة سر الفريق عبر الخدمة الحية (منفذ عابر معزول)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RADAR_DB_ROOT = await mkdtemp(path.join(os.tmpdir(), "radar-p5f2-"));
process.env.RADAR_SYNC_PORT = "0";
process.env.N8N_RADAR_WEBHOOK_URL = "http://127.0.0.1:9/x";

const mod = await import("../scripts/etimad-sync-service.mjs");
const server = mod.getSyncServer();
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

async function auth(body) {
  const res = await fetch(`${base}/agents/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test("P5-F2-1: first-time setup then login works", async () => {
  const setup = await auth({ action: "setup", newSecret: "الكلمة-الأولى-1" });
  assert.equal(setup.status, 200);
  const login = await auth({ teamSecret: "الكلمة-الأولى-1" });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
});

test("P5-F2-2: change requires the CURRENT secret — wrong current rejected", async () => {
  const { status, data } = await auth({
    action: "setup",
    newSecret: "الكلمة-الثانية-2",
    currentSecret: "خاطئة",
  });
  assert.equal(status, 400);
  assert.equal(data.error, "TEAM_CREDENTIAL_MISMATCH");
});

test("P5-F2-3: change with correct current succeeds and issues a fresh token", async () => {
  const { status, data } = await auth({
    action: "setup",
    newSecret: "الكلمة-الثانية-2",
    currentSecret: "الكلمة-الأولى-1",
  });
  assert.equal(status, 200);
  assert.ok(data.token);
});

test("P5-F2-4: the OLD secret stops working; the NEW one works", async () => {
  const oldTry = await auth({ teamSecret: "الكلمة-الأولى-1" });
  assert.equal(oldTry.status, 401);
  const newTry = await auth({ teamSecret: "الكلمة-الثانية-2" });
  assert.equal(newTry.status, 200);
});

test("P5-F2-5: change flow keeps admin endpoints working with the fresh token", async () => {
  const login = await auth({ teamSecret: "الكلمة-الثانية-2" });
  const token = login.data.token;
  const res = await fetch(`${base}/agents/update`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify({ roleCode: "scout", nameEn: "Yusuf-RENAMED" }),
  });
  assert.equal(res.status, 200);
  const list = await (await fetch(`${base}/agents`)).json();
  assert.equal(list.agents.find((a) => a.roleCode === "scout").nameEn, "Yusuf-RENAMED");
});
