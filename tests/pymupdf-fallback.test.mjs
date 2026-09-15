// P5-PYMUPDF: اختبارات معزولة لمسار pymupdf البديل الثالث في الاستخراج.
// تغطي: (أ) ملفان حقيقيان فشل فيهما pdf.js وpoppler معًا (فقدان عربي صامت،
// لا تجزئة حرفية) يتحولان لـpymupdf وينتجان نصًا عربيًا سليمًا بترتيب منطقي
// صحيح دون أي إصلاح RTL، (ب) extractPdfViaPymupdf المباشرة، (ج) الملفات التي
// يحلّها poppler أصلًا لا تصل لـpymupdf إطلاقًا (مغطاة أصلًا في
// poppler-fallback.test.mjs عبر تأكيد extractionMethod === "poppler-fallback").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractAnalysisDocument, extractPdfViaPymupdf } from "../scripts/lib/analysis-documents.mjs";
import { needsAlternateExtraction, isFragmentedDocument } from "../scripts/lib/analysis-quality-gates.mjs";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

async function metasFor(tenderReference) {
  const repository = await createRadarRepository({ projectRoot: path.resolve(".") });
  const metas = repository.listAttachmentMeta(tenderReference);
  return new Map((metas || []).map((m) => [m.displayName, m]));
}

// منافسة 260839009304 (كاميرات المراقبة، القصيم) — ملفا MEWA-INFOSEC-GOV-DOC0037/0038:
// خطوط مدمجة تُسقط العربي بصمت (تختفي دون أثر بينما يبقى الترقيم والاختصارات
// اللاتينية سليمة) — نمط لا يرفع نسبة التجزئة فيفلت من isFragmentedDocument وحدها.
const ARABIC_DROPPED = [
  "1- الشروط الخاصة في المشاريع للامن السبراني.pdf",
  "2- متطلبات الامن السيبراني للمشاريع.pdf",
];

test("P5-PYMUPDF: الملفان اللذان أسقطا العربي صامتًا عبر pdf.js وpoppler يتحولان لـpymupdf", async () => {
  const metaMap = await metasFor("260839009304");
  for (const name of ARABIC_DROPPED) {
    const meta = metaMap.get(name);
    assert.ok(meta?.localPath, `ملف غير مسجل: ${name}`);
    const buffer = readFileSync(meta.localPath);
    const doc = extractAnalysisDocument({ documentId: "pymu-test", fileName: name, buffer, maxBytes: 50 * 1024 * 1024 });
    assert.equal(doc.extractionMethod, "pymupdf-fallback", `يجب أن يتحول ${name} لـpymupdf`);
    assert.equal(needsAlternateExtraction(doc.blocks), false, `نص ${name} يجب أن يكون سليمًا بعد pymupdf`);
    const joined = doc.blocks.map((b) => b.text).join("\n");
    assert.ok(joined.includes("الشروط الخاصة") || joined.includes("متطلبات"), `النص العربي الفعلي يجب أن يظهر في ${name}`);
  }
});

test("P5-PYMUPDF: pdf.js وpoppler كلاهما فشلا فعليًا على نفس الملفين (يثبت الحاجة الحقيقية للطبقة الثالثة)", async () => {
  const metaMap = await metasFor("260839009304");
  for (const name of ARABIC_DROPPED) {
    const meta = metaMap.get(name);
    const buffer = readFileSync(meta.localPath);
    const pdfjsOnly = extractAnalysisDocument({
      documentId: "pdfjs-only", fileName: name, buffer, maxBytes: 50 * 1024 * 1024,
      allowPopplerFallback: false, allowPymupdfFallback: false,
    });
    // كلا المسارين البديلين معطّل — الكشف يقع لكن لا بديل يُجرَّب، فتبقى النتيجة
    // الأصلية موسومة "pdfjs-fragmented" (تسمية موحّدة لأي عطب متبقٍ، لا حصرًا تجزئة حرفية).
    assert.equal(pdfjsOnly.extractionMethod, "pdfjs-fragmented", `${name}: العطب يُكتشف حتى بلا أي مسار بديل مفعّل`);
    assert.equal(needsAlternateExtraction(pdfjsOnly.blocks), true, `${name}: pdf.js وحده معطوب فعليًا (فقدان عربي)`);
    assert.equal(isFragmentedDocument(pdfjsOnly.blocks), false, `${name}: ليست تجزئة حرفية — بوابة التجزئة وحدها عمياء عن هذا النمط`);

    const popplerOnly = extractAnalysisDocument({
      documentId: "poppler-only", fileName: name, buffer, maxBytes: 50 * 1024 * 1024,
      allowPopplerFallback: true, allowPymupdfFallback: false,
    });
    assert.equal(popplerOnly.extractionMethod, "pdfjs-fragmented", `${name}: poppler وحده لا يحل المشكلة فيبقى بلا مسار بديل`);
    assert.equal(needsAlternateExtraction(popplerOnly.blocks), true, `${name}: النتيجة النهائية بلا pymupdf تبقى معطوبة`);
  }
});

test("P5-PYMUPDF: extractPdfViaPymupdf المباشرة تنتج نصًا عربيًا سليمًا بترتيب منطقي دون إصلاح RTL", async () => {
  const metaMap = await metasFor("260839009304");
  const meta = metaMap.get("1- الشروط الخاصة في المشاريع للامن السبراني.pdf");
  assert.ok(meta?.localPath);
  const buffer = readFileSync(meta.localPath);
  const extracted = extractPdfViaPymupdf(buffer);
  assert.equal(extracted.extractionMethod, "pymupdf-fallback");
  const joined = extracted.blocks.map((b) => b.text).join("\n");
  assert.ok(joined.includes("الشروط الخاصة"), "الترتيب المنطقي سليم دون أي عكس كلمات");
  assert.ok(joined.includes("MEWA-INFOSEC-GOV-DOC0038"), "المعرف اللاتيني للمستند يبقى سليمًا");
});

test("P5-PYMUPDF: نطاق العمل يبقى حصريًا عبر pdf.js (لا تحويل حتى مع تفعيل الطبقتين البديلتين)", async () => {
  const metaMap = await metasFor("260839005042");
  const meta = [...metaMap.values()].find((m) => (m.displayName || "").includes("نطاق"));
  assert.ok(meta?.localPath, "نطاق العمل غير مسجل");
  const buffer = readFileSync(meta.localPath);
  const doc = extractAnalysisDocument({ documentId: "nitaq-pymu", fileName: "نطاق العمل.pdf", buffer, maxBytes: 50 * 1024 * 1024 });
  assert.equal(doc.extractionMethod, "pdfjs", "نطاق العمل يجب أن يبقى عبر pdf.js حصريًا");
});
