// P5-POPPLER: اختبارات معزولة لمسار poppler البديل في الاستخراج.
// تغطي: (أ) الملفات المجزأة تتحول لـpoppler وتنتج كلمات عربية كاملة،
// (ب) نطاق العمل يبقى حصريًا عبر pdf.js (لا تحويل)،
// (ج) السطر المختلط يحافظ على الأرقام سليمة.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractAnalysisDocument, extractPdfViaPoppler } from "../scripts/lib/analysis-documents.mjs";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

async function metasFor(tenderReference) {
  const repository = await createRadarRepository({ projectRoot: path.resolve(".") });
  const metas = repository.listAttachmentMeta(tenderReference);
  return new Map((metas || []).map((m) => [m.displayName, m]));
}

const THREE = [
  "التقييم الفني لمنافسة توريد وتركيب مصدات الأبواب المغناطسية وربطها بنظام الإنذار بالمستشفى.pdf",
  "ملحق الغرامات 004.pdf",
  "ملحق عام منافسة توريد وتركيب مصدات الابواب المغناطيسية.pdf",
];

test("P5-POPPLER: الملفات الثلاثة المجزأة تتحول لـpoppler وتنتج كلمات عربية كاملة", async () => {
  const metaMap = await metasFor("260839003247");
  for (const name of THREE) {
    const meta = metaMap.get(name);
    assert.ok(meta?.localPath, `ملف غير مسجل: ${name}`);
    const buffer = readFileSync(meta.localPath);
    const doc = extractAnalysisDocument({ documentId: "pop-test", fileName: name, buffer, maxBytes: 50 * 1024 * 1024 });
    assert.equal(doc.extractionMethod, "poppler-fallback", `يجب أن يتحول ${name} لـpoppler`);
    const longBlocks = doc.blocks.filter((b) => b.text.trim().length >= 4);
    assert.ok(longBlocks.length > 0, `لا كلمات كاملة في ${name}`);
    // المقياس الصحيح للنجاح هو متوسط طول الكتلة (كان ~1.5 في pdf.js المجزأ)،
    // لا نسبة المفردة — لأن جداول الأرقام (نسب/مبالغ) قصيرة طبيعيًا.
    const avgLen = doc.blocks.reduce((s, b) => s + b.text.trim().length, 0) / doc.blocks.length;
    assert.ok(avgLen >= 4, `متوسط طول الكتلة ما زال مجزأً في ${name}: ${avgLen.toFixed(2)}`);
  }
});

test("P5-POPPLER: نطاق العمل يبقى حصريًا عبر pdf.js (لا تحويل)", async () => {
  const metaMap = await metasFor("260839005042");
  const meta = [...metaMap.values()].find((m) => (m.displayName || "").includes("نطاق"));
  assert.ok(meta?.localPath, "نطاق العمل غير مسجل");
  const buffer = readFileSync(meta.localPath);
  const doc = extractAnalysisDocument({ documentId: "nitaq", fileName: "نطاق العمل.pdf", buffer, maxBytes: 50 * 1024 * 1024 });
  assert.equal(doc.extractionMethod, "pdfjs", "نطاق العمل يجب أن يبقى عبر pdf.js حصريًا");
  const joined = doc.blocks.map((b) => b.text).join("\n");
  assert.ok(joined.includes("نطاق العمل"), "النص العربي سليم عبر pdf.js");
});

test("P5-POPPLER: عكس الكلمات يحافظ على الأرقام واللاتيني سليمة", async () => {
  const metaMap = await metasFor("260839003247");
  const meta = metaMap.get("ملحق عام منافسة توريد وتركيب مصدات الابواب المغناطيسية.pdf");
  assert.ok(meta?.localPath, "ملحق العام غير مسجل");
  const buffer = readFileSync(meta.localPath);
  const doc = extractAnalysisDocument({ documentId: "mixed", fileName: "ملحق عام.pdf", buffer, maxBytes: 50 * 1024 * 1024 });
  const joined = doc.blocks.map((b) => b.text).join("\n");
  assert.ok(joined.includes("0598944441"), "الرقم 0598944441 يبقى سليمًا دون عكس");
  assert.ok(!joined.includes("1444498950"), "الرقم لم يُعكس");
});

test("P5-POPPLER: extractPdfViaPoppler المباشرة تنتج كلمات عربية سليمة", async () => {
  const metaMap = await metasFor("260839003247");
  const meta = metaMap.get("ملحق الغرامات 004.pdf");
  assert.ok(meta?.localPath, "ملحق الغرامات غير مسجل");
  const buffer = readFileSync(meta.localPath);
  const extracted = extractPdfViaPoppler(buffer);
  assert.equal(extracted.extractionMethod, "poppler-fallback");
  const joined = extracted.blocks.map((b) => b.text).join("\n");
  assert.ok(joined.includes("ملحق الغرامات"), "يجب أن يظهر 'ملحق الغرامات' بالترتيب الصحيح");
  assert.ok(joined.includes("تطبيق الغرامات"), "يجب أن تظهر 'تطبيق الغرامات' سليمة");
});
