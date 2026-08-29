import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFragmentationRatio,
  isFragmentedDocument,
  assessCoverageBalance,
  coverageWarningMessage,
} from "../scripts/lib/analysis-quality-gates.mjs";

// ── fixture: كتل من حروف منفردة (نص مجزأ) ──
function fragmentedBlocks(n) {
  const chars = ["م", "ي", "ي", "ق", "ت", "ل", "ا", "ة", "ب", "س", "ر", "ف"];
  return Array.from({ length: n }, (_, i) => ({ blockId: `p1-l${i + 1}`, text: chars[i % chars.length] }));
}

// ── fixture: كتل سليمة (كلمات كاملة) ──
function healthyBlocks(n) {
  return Array.from({ length: n }, (_, i) => ({
    blockId: `p1-l${i + 1}`,
    text: `فقرة كاملة ذات معنى ${i + 1} تحتوي كلمات مترابطة`,
  }));
}

test("P5-QGATE-1: computeFragmentationRatio يحسب نسبة الكتل المفردة بدقة", () => {
  // 9 كتل مفردة + 1 كتلة سليمة = 90%
  const blocks = [...fragmentedBlocks(9), { blockId: "p1-l10", text: "جملة كاملة صحيحة" }];
  assert.equal(computeFragmentationRatio(blocks), 0.9);
});

test("P5-QGATE-2: isFragmentedDocument يرفض نصًا مجزأً بنسبة >90%", () => {
  // 92 مفردة + 8 سليمة = 92% مفردة → مجزأ
  const blocks = [...fragmentedBlocks(92), ...healthyBlocks(8)];
  assert.equal(isFragmentedDocument(blocks), true);
});

test("P5-QGATE-3: isFragmentedDocument يقبل نصًا سليمًا (نسبة منخفضة)", () => {
  // 10 كتل سليمة فقط = 0% مفردة → ليس مجزأ
  const blocks = healthyBlocks(10);
  assert.equal(isFragmentedDocument(blocks), false);
});

test("P5-QGATE-4: هيمنة ملف واحد (≥80% من الأدلة) تُعلّم التغطية غير متوازنة", () => {
  // ملف واحد يحمل 9 من 10 أدلة = 90% → هيمنة
  const result = assessCoverageBalance({
    "جدول الكميات.pdf": 9,
    "التقييم الفني.pdf": 0,
    "ملحق الغرامات.pdf": 0,
    "الملحق العام.pdf": 1,
  });
  assert.equal(result.dominant, true);
  assert.equal(result.unbalanced, true);
  assert.ok(Math.abs(result.dominantRatio - 0.9) < 1e-9);
});

test("P5-QGATE-5: ملفان أو أكثر بصفر أدلة تُعلّم التغطية غير متوازنة", () => {
  // لا هيمنة (توزيع 5/5)، لكن ملفان بصفر أدلة
  const result = assessCoverageBalance({
    "a.pdf": 5,
    "b.pdf": 5,
    "c.pdf": 0,
    "d.pdf": 0,
  });
  assert.equal(result.dominant, false);
  assert.equal(result.tooManyZero, true);
  assert.equal(result.unbalanced, true);
});

test("P5-QGATE-6: تغطية متوازنة (لا هيمنة ولا صفر) → غير متوازنة=false", () => {
  const result = assessCoverageBalance({
    "a.pdf": 3,
    "b.pdf": 2,
    "c.pdf": 3,
    "d.pdf": 2,
  });
  assert.equal(result.unbalanced, false);
});

test("P5-QGATE-7: coverageWarningMessage ينتج الرسالة الصريحة المطلوبة", () => {
  const msg = coverageWarningMessage({ unbalanced: true, filesWithZero: 2, totalFiles: 4 });
  assert.equal(msg, "التغطية غير متوازنة: 2 من 4 ملفات لم تساهم بأدلة");
  assert.equal(coverageWarningMessage({ unbalanced: false, filesWithZero: 0, totalFiles: 4 }), null);
});
