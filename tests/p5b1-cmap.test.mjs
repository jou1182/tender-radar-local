// النسخة المنفذة تحوي الإصلاح لكن المخرجات مكسورة. طباعة داخلية عبر Node --experimental? 
// الأسرع: أعِد كتابة الاختبار على الكراسة الحقيقية مباشرة (المصدر المهم) بدل fixture الاصطناعي
// — الfixture الاصطناعي بـcmap غير مضغوط قد يخالف افتراضات أعمق. الاختبار الحقيقي هو الكراسة نفسها.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractAnalysisDocument } from "../scripts/lib/analysis-documents.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pdfPath = path.join(scriptRoot, "..", "radar", ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");

test("P5-B1: real booklet (260839005042) extracts readable Arabic via CMap", async () => {
  const buffer = await readFile(pdfPath);
  const doc = extractAnalysisDocument({
    documentId: "doc-cmap-live",
    fileName: "نطاق العمل.pdf",
    buffer,
    maxBytes: 10 * 1024 * 1024,
  });
  const allText = doc.blocks.map((b) => b.text).join(" ");
  console.log("إجمالي النص:", allText.length);
  console.log("عينة:", allText.replace(/\s+/g, " ").slice(0, 120));
  assert.ok(allText.length > 3000, `النص المستخرج قصير جدًا: ${allText.length}`);
  assert.ok(/[\u0600-\u06FF]{3,}/.test(allText), "لا توجد كلمات عربية متصلة");
  assert.ok(!/\u0003/.test(allText), "لا بقايا CID مكسورة");
  assert.equal(doc.documentType, "pdf");
});
