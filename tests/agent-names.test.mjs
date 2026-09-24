// P5-F1R — تحقق أسماء الوكلاء: منع الاسم الفارغ (عربي/إنجليزي) + الصدق في «ما تغيّر».
// طبقة المستودع + الوحدة النقية + حارس الواجهة هنا؛ وطبقة المسار عبر الخدمة في
// tests/agent-names-api.test.mjs. كلاهما معزول تمامًا (قاعدة مؤقتة/منفذ عابر) —
// لا يمس خدمة 4318 الحية ولا قاعدة التشغيل.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { computeAgentNameChanges } from "../scripts/lib/agent-name-change.mjs";

const isNameRequired = (e) => e?.code === "AGENT_NAME_REQUIRED";

// ── (أ) المستودع ─────────────────────────────────────────────────────────────

test("P5-F1R-1: اسم عربي فارغ أو مسافات فقط يُرفض ولا يغيّر أي حقل", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-agentnames-repo-"));
  const repo = await createRadarRepository({ projectRoot });
  const before = repo.getAgentByRole("scout");
  for (const empty of ["", "   ", "\t \n "]) {
    assert.throws(
      () => repo.updateAgentProfile("scout", { nameAr: empty }),
      isNameRequired,
      `يجب رفض الاسم العربي ${JSON.stringify(empty)}`,
    );
  }
  const after = repo.getAgentByRole("scout");
  assert.equal(after.name_ar, before.name_ar, "الاسم العربي القديم سليم");
  assert.equal(after.name_en, before.name_en, "الاسم الإنجليزي لم يُمس");
  repo.close();
});

test("P5-F1R-2: اسم إنجليزي فارغ أو مسافات فقط يُرفض ولا يغيّر أي حقل", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-agentnames-repo2-"));
  const repo = await createRadarRepository({ projectRoot });
  const before = repo.getAgentByRole("auditor");
  for (const empty of ["", "  ", "\n"]) {
    assert.throws(
      () => repo.updateAgentProfile("auditor", { nameEn: empty }),
      isNameRequired,
      `يجب رفض الاسم الإنجليزي ${JSON.stringify(empty)}`,
    );
  }
  const after = repo.getAgentByRole("auditor");
  assert.equal(after.name_en, before.name_en);
  assert.equal(after.name_ar, before.name_ar);
  repo.close();
});

test("P5-F1R-3: تغيير العربي وحده يترك الإنجليزي كما هو (وبالعكس)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-agentnames-repo3-"));
  const repo = await createRadarRepository({ projectRoot });

  repo.updateAgentProfile("reporter", { nameAr: "بدر" });
  let agent = repo.getAgentByRole("reporter");
  assert.equal(agent.name_ar, "بدر");
  assert.equal(agent.name_en, "Fahad", "الإنجليزي بقي كما هو");

  repo.updateAgentProfile("reporter", { nameEn: "Badr" });
  agent = repo.getAgentByRole("reporter");
  assert.equal(agent.name_ar, "بدر", "العربي بقي كما هو");
  assert.equal(agent.name_en, "Badr");
  repo.close();
});

test("P5-F1R-4: وكيل غير معروف يُرفض بكود صريح AGENT_NOT_FOUND", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-agentnames-repo4-"));
  const repo = await createRadarRepository({ projectRoot });
  assert.throws(
    () => repo.updateAgentProfile("ghost", { nameAr: "شبح" }),
    (e) => e?.code === "AGENT_NOT_FOUND",
  );
  repo.close();
});

// ── الوحدة النقية: تحديد ما تغيّر فعلًا ──────────────────────────────────────

test("P5-F1R-9: computeAgentNameChanges يعلن الحقول المتغيّرة فقط", () => {
  const current = { name_ar: "فهد", name_en: "Fahad" };
  assert.deepEqual(computeAgentNameChanges(current, { nameAr: "بدر" }), ["nameAr"], "العربي وحده");
  assert.deepEqual(computeAgentNameChanges(current, { nameEn: "Badr" }), ["nameEn"], "الإنجليزي وحده");
  assert.deepEqual(computeAgentNameChanges(current, { nameAr: "بدر", nameEn: "Badr" }), ["nameAr", "nameEn"], "الاثنان");
  assert.deepEqual(computeAgentNameChanges(current, {}), [], "لا حقول مرسلة ⇒ لا تغيير");
  assert.deepEqual(computeAgentNameChanges(current, { nameAr: "فهد", nameEn: "Fahad" }), [], "قيم مطابقة ⇒ لا تغيير");
  assert.deepEqual(computeAgentNameChanges(current, { nameAr: "  فهد  " }), [], "المسافات تُقلّم قبل المقارنة");
  assert.deepEqual(computeAgentNameChanges(current, { nameAr: "فهد", nameEn: "Badr" }), ["nameEn"], "المطابق لا يُعلن");
});

// ── حارس بنيوي على الواجهة (نمط المستودع في اختبارات البنية) ────────────────

test("P5-F1R-10: واجهة الاسم لا ترجع صامتةً ولا ترسل اسمًا فارغًا وتعتمد changed", async () => {
  const src = await readFile(new URL("../app/agent-management.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /nameEnDraft \|\| agent\.nameEn/, "زال الرجوع الصامت للاسم الإنجليزي القديم");
  assert.match(src, /if \(!nameAr\)/, "الواجهة تمنع الاسم العربي الفارغ");
  assert.match(src, /if \(!nameEn\)/, "الواجهة تمنع الاسم الإنجليزي الفارغ");
  assert.match(src, /data\.changed/, "رسالة الحفظ مبنية على ما أعلنه الخادم فعلًا");
  assert.doesNotMatch(src, /تم حفظ الاسم \(عربي \+ إنجليزي\)/, "زالت الرسالة الموحّدة المضلّلة");
  // العطل الذي كشفه الفحص البصري: flash كان يُكتب ولا يُعرض في تبويب الاسم إطلاقًا.
  const nameTab = src.slice(src.indexOf('activeTab === "name" && ('), src.indexOf('activeTab === "training" && ('));
  assert.match(nameTab, /<em className="panel-msg">\{flash\}<\/em>/, "تبويب الاسم يعرض رسالة الحفظ فعليًا");
});
