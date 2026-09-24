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
import { computeAgentProfileChanges, describeAgentChanges } from "../scripts/lib/agent-profile-change.mjs";

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

test("P5-F1R-10: computeAgentProfileChanges يعلن الحقول المتغيّرة فقط", () => {
  const current = { name_ar: "فهد", name_en: "Fahad", enabled: 1, display_order: 5 };
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: "بدر" }), ["nameAr"], "العربي وحده");
  assert.deepEqual(computeAgentProfileChanges(current, { nameEn: "Badr" }), ["nameEn"], "الإنجليزي وحده");
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: "بدر", nameEn: "Badr" }), ["nameAr", "nameEn"], "الاثنان");
  assert.deepEqual(computeAgentProfileChanges(current, {}), [], "لا حقول مرسلة ⇒ لا تغيير");
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: "فهد", nameEn: "Fahad" }), [], "قيم مطابقة ⇒ لا تغيير");
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: "  فهد  " }), [], "المسافات تُقلّم قبل المقارنة");
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: "فهد", nameEn: "Badr" }), ["nameEn"], "المطابق لا يُعلن");
  // P5-F1R (M1): الواجهة الثانية تحفظ حالة التشغيل أيضًا ⇒ يجب إعلانها بصدق.
  assert.deepEqual(computeAgentProfileChanges(current, { enabled: false }), ["enabled"], "إطفاء يُعلن");
  assert.deepEqual(computeAgentProfileChanges(current, { enabled: true }), [], "نفس الحالة لا تُعلن");
  assert.deepEqual(computeAgentProfileChanges(current, { displayOrder: 2 }), ["displayOrder"], "تغيير الترتيب");
  // P5-F1R (M2): قيمة غير نصية للاسم مدخل غير صالح ⇒ لا ندّعي تغييرًا (المستودع يرفضه).
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: null }), [], "null ليس تغييرًا");
  assert.deepEqual(computeAgentProfileChanges(current, { nameAr: 0 }), [], "0 ليس تغييرًا");
  assert.deepEqual(computeAgentProfileChanges(current, { nameEn: false }), [], "false ليس تغييرًا");
});

test("P5-F1R-11: describeAgentChanges لا يقول «تم الحفظ» بلا تغيير", () => {
  assert.equal(describeAgentChanges([]), "لا تغيير لحفظه — القيم كما هي.");
  assert.equal(describeAgentChanges(["nameAr"]), "تم حفظ الاسم العربي ✓");
  assert.equal(describeAgentChanges(["nameAr", "nameEn"]), "تم حفظ الاسم العربي + الاسم الإنجليزي ✓");
  assert.equal(describeAgentChanges(["enabled"]), "تم حفظ حالة التشغيل ✓");
  assert.equal(describeAgentChanges(undefined), "لا تغيير لحفظه — القيم كما هي.", "بلا قائمة ⇒ لا ادعاء");
  assert.equal(describeAgentChanges(["unknownField"]), "لا تغيير لحفظه — القيم كما هي.", "حقل مجهول لا يُعلن");
});

// ── حارس بنيوي على الواجهتين (نمط المستودع في اختبارات البنية) ───────────────

test("P5-F1R-12: واجهة الإدارة لا ترجع صامتةً ولا ترسل اسمًا فارغًا وتُظهر الرسالة", async () => {
  const src = await readFile(new URL("../app/agent-management.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /nameEnDraft \|\| agent\.nameEn/, "زال الرجوع الصامت للاسم الإنجليزي القديم");
  assert.match(src, /if \(!nameAr\)/, "الواجهة تمنع الاسم العربي الفارغ");
  assert.match(src, /if \(!nameEn\)/, "الواجهة تمنع الاسم الإنجليزي الفارغ");
  assert.match(src, /describeAgentChanges\(/, "الرسالة من المصدر الواحد الصادق");
  assert.doesNotMatch(src, /تم حفظ الاسم \(عربي \+ إنجليزي\)/, "زالت الرسالة الموحّدة المضلّلة");
  // العطل الذي كشفه الفحص البصري: flash كان يُكتب ولا يُعرض في تبويب الاسم إطلاقًا.
  const nameTab = src.slice(src.indexOf('activeTab === "name" && ('), src.indexOf('activeTab === "training" && ('));
  assert.match(nameTab, /<em className="panel-msg">\{flash\}<\/em>/, "تبويب الاسم يعرض رسالة الحفظ فعليًا");
});

test("P5-F1R-13: لوحة الفريق لا ترجع صامتةً ولا تدّعي «تم الحفظ ✓» دائما", async () => {
  // M1 في المراجعة المستقلة: سطح ثانٍ لإعادة التسمية كان يرجع للاسم القديم بصمت
  // ويُظهر «تم الحفظ ✓» دائمًا — بلا اختبار يغطيه.
  const src = await readFile(new URL("../app/agent-team.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /nameAr: editName \|\| agent\.nameAr/, "زال الرجوع الصامت في لوحة الفريق");
  assert.match(src, /if \(!nameAr\)/, "لوحة الفريق تمنع الاسم الفارغ");
  assert.match(src, /describeAgentChanges\(/, "لوحة الفريق تستخدم الرسالة الصادقة نفسها");
  assert.doesNotMatch(src, /res\.ok \? "تم الحفظ ✓"/, "زالت الرسالة الثابتة المضلّلة");
});
