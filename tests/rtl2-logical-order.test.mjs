import test from "node:test";
import assert from "node:assert/strict";
import { extractAnalysisDocument } from "../scripts/lib/analysis-documents.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

// مسار الكراسة الحقيقية المنزّلة حيًا (P5-B0): منافسة القصيم 260839005042
const REAL_BOOKLET = path.resolve(
  "..", "radar", ".radar-data", "attachments", "260839005042",
  "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf",
);

test("RTL-2: النص العربي من الكراسة الحقيقية بترتيب منطقي صحيح (لا عكس أعمى)", async () => {
  let buffer;
  try {
    buffer = readFileSync(REAL_BOOKLET);
  } catch {
    throw new Error("ملف الكراسة الحقيقية غير موجود — شغّل التنزيل الحي أولًا (P5-B0).");
  }
  const doc = extractAnalysisDocument({
    documentId: "uat-rtl2", fileName: "x.pdf", buffer, maxBytes: 50 * 1024 * 1024,
  });
  const all = doc.blocks.map((b) => b.text).join("\n");

  // لم يعد معكوسًا بصريًا
  assert.ok(!all.includes("روبع ةذفان"), "لا يجب أن يظهر النص معكوسًا");
  assert.ok(!all.includes("لمعلا قاطن"), "لا يجب أن يظهر 'نطاق عمل' معكوسًا");

  // ترتيب منطقي صحيح
  assert.ok(all.includes("نطاق العمل"), "يجب أن يظهر 'نطاق العمل' بالترتيب الصحيح");
  assert.ok(all.includes("تحضير الأدوية الكيميائية"), "اللام-ألف مركّب وترتيب الكلمات صحيح");

  // لا لام-ألف مفكوك
  assert.ok(!/األ|اإل|اآل/.test(all), "لا يجب أن يظهر لام-ألف مفكوك");

  // الكلمات اللاتينية لا تُعكس داخليًا
  const latin = doc.blocks.find((b) => b.text.includes("Passthrough"));
  assert.ok(latin && latin.text.includes("Passthrough"), "المصطلح الإنجليزي يبقى بلا عكس داخلي");
});
