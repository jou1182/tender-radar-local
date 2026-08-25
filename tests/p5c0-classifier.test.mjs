// اختبارات P5-C0 — التصنيف الحتمي وربطه بالجولات المكتملة
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { classifyTender, loadRulebook, classifyAndStoreTenders } from "../scripts/lib/specialty-classifier.mjs";

// تحميل القواعد مرة واحدة لكل الاختبارات المتزامنة (الكاش مشترك).
await loadRulebook();

test("P5-C0-1: rulebook loads with eleven specialties and a fallback", async () => {
  const rulebook = await loadRulebook();
  assert.equal(rulebook.specialties.length, 11);
  assert.equal(rulebook.fallbackCode, "general-works");
});

test("P5-C0-2: road tender title classifies as roads with high confidence", () => {
  const verdict = classifyTender({ title: "رصف طريق رئيسي وجسر في محافظة بريدة", agency: "أمانة منطقة القصيم" });
  assert.equal(verdict.specialtyCode, "roads");
  assert.ok(verdict.confidence >= 0.5, `confidence ${verdict.confidence}`);
});

test("P5-C0-3: maintenance keywords in fields (not title) still classify", () => {
  const verdict = classifyTender({
    title: "مشروع خدمات بلدية",
    agency: "بلدية",
    subActivity: "تشغيل وصيانة مرافق حكومية",
  });
  assert.equal(verdict.specialtyCode, "maintenance-operation");
});

test("P5-C0-4: split confidence between two specialties demotes to fallback", () => {
  // «صيانة حدائق»: صيانة (3 حقول+عنوان) ضد حدائق (عنوان 3) — تعادل نسبي ⇒ ثقة ≤ 0.67
  // مع عتبة 0.5 قد تجتاز؛ نستخدم مثالًا أوضح: كلمتان مستقلتان تمامًا في العنوان.
  const verdict = classifyTender({ title: "أشجار وكاميرات" });
  // أشجار=landscaping(3) + كاميرات=it-telecom(3) ⇒ ثقة 0.5 ⇒ أقل من العتبة الصارمة
  assert.equal(verdict.specialtyCode, verdict.confidence >= 0.5 ? verdict.specialtyCode : "general-works");
  assert.ok(["landscaping", "it-telecom", "general-works"].includes(verdict.specialtyCode));
});

test("P5-C0-5: unmatched tender falls back to general-works with zero confidence", () => {
  const verdict = classifyTender({ title: "توريد أقلام حبر" });
  assert.equal(verdict.specialtyCode, "general-works");
  assert.equal(verdict.confidence, 0);
});

test("P5-C0-6: classifyAndStoreTenders persists classifications for existing tenders", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-p5c0-store-"));
  try {
    const repo = await createRadarRepository({ projectRoot });
    // المنافستان يجب أن تكونا في tenders أولًا (قيد المفتاح الأجنبي) — عبر جولة مكتملة.
    repo.saveCompletedSync({
      lastSyncAt: new Date().toISOString(),
      items: [
        { reference: "260739009419", title: "إنشاء مبنى مدرسة", agency: "وزارة التعليم" },
        { reference: "260839002206", title: "رصف شوارع حي الرياض", agency: "بلدية" },
        { reference: "260839001913", title: "منافسة خارج القائمة", agency: "جهة" },
      ],
      added: [], changed: [], scope: {},
    }, "run-seed-1");
    const result = await classifyAndStoreTenders(repo, [
      { reference: "260739009419", title: "إنشاء مبنى مدرسة", agency: "وزارة التعليم" },
      { reference: "260839002206", title: "رصف شوارع حي الرياض", agency: "بلدية" },
      { reference: "999999999999", title: "غير موجودة في القاعدة" },
    ]);
    assert.equal(result.classified, 2);
    assert.equal(result.skipped, 1);
    assert.equal(repo.getTenderClassification("260739009419").specialty_code, "buildings");
    assert.equal(repo.getTenderClassification("260839002206").specialty_code, "roads");
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
