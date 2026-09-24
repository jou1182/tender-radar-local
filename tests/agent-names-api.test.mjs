// P5-F1R-API — مسار /agents/update: منع الاسم الفارغ + إعلان ما تغيّر بصدق.
// خدمة حقيقية على منفذ عابر معزول + قاعدة مؤقتة — لا يمس 4318 الحية ولا قاعدة التشغيل.
// (مفصول عن اختبارات المستودع عمدًا: node:test يبدأ التنفيذ فور التسجيل، فخلط
// اختبارات الخدمة مع اختبارات متزامنة يُلحق هوك after باختبار جارٍ ويُغلق الخادم مبكرًا.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── (ب) المسار عبر الخدمة ────────────────────────────────────────────────────

process.env.RADAR_DB_ROOT = await mkdtemp(path.join(os.tmpdir(), "radar-agentnames-svc-"));
process.env.RADAR_SYNC_PORT = "0";
process.env.N8N_RADAR_WEBHOOK_URL = "http://127.0.0.1:9/unreachable";

const serviceMod = await import("../scripts/etimad-sync-service.mjs");
const server = serviceMod.getSyncServer();
await new Promise((resolve, reject) => {
  if (server.listening) return resolve();
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = `http://127.0.0.1:${server.address().port}`;
console.log("[diag] module-load pid:", process.pid, "listening:", server.listening, "addr:", JSON.stringify(server.address()));
test.after(() => new Promise((resolve) => server.close(resolve)));

const auth = await fetch(`${base}/agents/auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "setup", newSecret: "سر-الأسماء-12345" }),
});
const token = (await auth.json()).token;

async function update(payload) {
  const res = await fetch(`${base}/agents/update`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function agentOf(roleCode) {
  const list = await (await fetch(`${base}/agents`)).json();
  return list.agents.find((a) => a.roleCode === roleCode);
}

test("P5-F1R-5: الاسم الفارغ عبر الـAPI يُرفض 400 (لا 404) ولا يغيّر شيئًا", async () => {
  const before = await agentOf("courier");

  const emptyAr = await update({ roleCode: "courier", nameAr: "   " });
  assert.equal(emptyAr.status, 400, "خطأ تحقق ≠ غير موجود");
  assert.equal(emptyAr.body.error, "AGENT_NAME_REQUIRED");

  const emptyEn = await update({ roleCode: "courier", nameEn: "" });
  assert.equal(emptyEn.status, 400);
  assert.equal(emptyEn.body.error, "AGENT_NAME_REQUIRED");

  const after = await agentOf("courier");
  assert.equal(after.nameAr, before.nameAr);
  assert.equal(after.nameEn, before.nameEn);
});

test("P5-F1R-6: وكيل غير معروف يبقى 404 AGENT_NOT_FOUND", async () => {
  const res = await update({ roleCode: "ghost", nameAr: "شبح" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "AGENT_NOT_FOUND");
});

test("P5-F1R-7: الـAPI يُعلن ما تغيّر فعلًا (changed) بصدق", async () => {
  const arabicOnly = await update({ roleCode: "sentinel", nameAr: "نجود" });
  assert.equal(arabicOnly.status, 200);
  assert.deepEqual(arabicOnly.body.changed, ["nameAr"], "العربي وحده تغيّر");
  const afterAr = await agentOf("sentinel");
  assert.equal(afterAr.nameAr, "نجود");
  assert.equal(afterAr.nameEn, "Sadeem", "الإنجليزي لم يُمس");

  const englishOnly = await update({ roleCode: "sentinel", nameEn: "Nujud" });
  assert.equal(englishOnly.status, 200);
  assert.deepEqual(englishOnly.body.changed, ["nameEn"], "الإنجليزي وحده تغيّر");
  const afterEn = await agentOf("sentinel");
  assert.equal(afterEn.nameAr, "نجود", "العربي لم يُمس");
  assert.equal(afterEn.nameEn, "Nujud");

  const noop = await update({ roleCode: "sentinel", nameAr: "نجود", nameEn: "Nujud" });
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.body.changed, [], "لا تغيير فعلي ⇒ لا ادعاء بتغيير");
});

test("P5-F1R-8: سجل النشاط يسجّل الحقول المتغيرة فقط بصدق", async () => {
  await update({ roleCode: "scout", nameAr: "سالم" });
  const list = await (await fetch(`${base}/agents`)).json();
  const entry = list.activity.find((item) => item.agent_role_code === "scout" && item.action === "profile-updated");
  assert.ok(entry, "سجل النشاط يحتوي تعديل الملف");
  const detail = JSON.parse(entry.detail_json);
  assert.deepEqual(detail.changed, ["nameAr"], "السجل يذكر العربي فقط");
  assert.equal(detail.nameAr, "سالم");
});

test("P5-F1R-9: preflight يسمح برأس x-team-token (وإلا فشل كل حفظ من الواجهة)", async () => {
  // عطل حقيقي مُكتشف بمتصفح حقيقي: كان Access-Control-Allow-Headers = "Content-Type" فقط،
  // فيرفض المتصفح preflight لطلبات x-team-token وتفشل كل الكتابات الموثّقة (Failed to fetch).
  // اختبارات الـAPI لا تكشفه لأن Node لا يفرض CORS إطلاقًا.
  const res = await fetch(`${base}/agents/update`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-team-token",
    },
  });
  assert.equal(res.status, 204);
  const allowed = String(res.headers.get("access-control-allow-headers") || "").toLowerCase();
  assert.ok(allowed.includes("x-team-token"), `الرؤوس المسموحة فعليًا: ${allowed}`);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("P5-F1R-14: تغيير حالة التشغيل يُعلن في changed (لوحة الفريق تعتمد عليه)", async () => {
  // P5-F1R (M1): لوحة «فريق الوكلاء» تحفظ الاسم والحالة معًا — فلا بد أن يُعلن
  // الخادم تغيير الحالة أيضًا، وإلا قالت الرسالة «لا تغيير» بينما الحالة تغيّرت.
  const before = await agentOf("reporter");
  const flip = await update({ roleCode: "reporter", enabled: !before.enabled });
  assert.equal(flip.status, 200);
  assert.deepEqual(flip.body.changed, ["enabled"], "إعلان حالة التشغيل وحدها");
  const again = await update({ roleCode: "reporter", enabled: !before.enabled });
  assert.deepEqual(again.body.changed, [], "إعادة الإرسال لنفس القيمة ⇒ لا تغيير");
  await update({ roleCode: "reporter", enabled: before.enabled });
});
