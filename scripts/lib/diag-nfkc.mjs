// التشخيص النهائي: النص يظهر بحروف "أشكال عرضية" (Presentation Forms U+FB50–U+FEFF)
// مثال: "لﻣﻌﻟا" — الحرف ﻣ هي مييم الشكل العرضي (U+FEA3). لهذا البحث عن "كفاءة" (بالحروف
// المعيارية U+0600) لا يجدها. الحل: تطبيع Unicode NFKC يحول الأشكال العرضية للحروف القياسية.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAnalysisDocument } from "../../scripts/lib/analysis-documents.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..", "radar");
const storedPath = path.join(projectRoot, ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");
const buffer = await readFile(storedPath);
const doc = extractAnalysisDocument({ documentId: "nfkc", fileName: "x.pdf", buffer, maxBytes: 10 * 1024 * 1024 });
const all = doc.blocks.map((b) => b.text).join("\n");
const normalized = all.normalize("NFKC");
console.log("طول قبل/بعد:", all.length, normalized.length);
// عكس الأسطر العربية (visual → logical)
function fixRtlLine(line) {
  const ar = (line.match(/[\u0600-\u06FF\uFB50-\uFEFF]/g) || []).length;
  const total = line.replace(/\s/g, "").length;
  if (total > 0 && ar / total > 0.6) return [...line].reverse().join("");
  return line;
}
const fixed = normalized.split("\n").map(fixRtlLine).join("\n");
console.log("عينة بعد NFKC+RTL:", fixed.replace(/\s+/g, " ").slice(200, 480));
for (const kw of ["كفاءة", "ضمان", "نطاق", "معايير", "الزيارة"]) {
  console.log(kw, ":", fixed.includes(kw) ? "موجود ✓" : "غير موجود");
}
