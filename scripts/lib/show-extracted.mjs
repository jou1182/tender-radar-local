// P5-B1C: إظهار نص الاستخراج الفعلي بعد التنقية — نرى ماذا يرى النموذج بالضبط
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractAnalysisDocument } from "../../scripts/lib/analysis-documents.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..", "radar");
const storedPath = path.join(projectRoot, ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");
const buffer = await readFile(storedPath);
const doc = extractAnalysisDocument({
  documentId: "show",
  fileName: "نطاق العمل.pdf",
  buffer,
  maxBytes: 10 * 1024 * 1024,
});
console.log("blocks:", doc.blocks.length);
// أول 15 بلوكًا كما يراها النموذج
for (const b of doc.blocks.slice(0, 15)) {
  console.log(`[${b.source.pageNumber}]`, JSON.stringify(b.text.slice(0, 100)));
}
// البحث عن كلمات مفتاحية مهمة للقرار: كفاءة، مخالفات، ضمان، مدة
const all = doc.blocks.map((b) => b.text).join("\n");
for (const kw of ["كفاءة", "ضمان", "مدة", "مخالفة", "عقوبة", "نطاق", "زيارة", "معايير"]) {
  const hits = all.split("\n").filter((l) => l.includes(kw));
  console.log(`--- ${kw}: ${hits.length} سطر`);
  for (const h of hits.slice(0, 2)) console.log("    ", JSON.stringify(h.slice(0, 110)));
}
