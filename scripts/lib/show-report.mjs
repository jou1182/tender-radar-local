import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(path.resolve("..", "radar", ".radar-data", "radar.sqlite"));
const j = db.prepare("SELECT report_json FROM analysis_jobs ORDER BY created_at DESC LIMIT 1").get();
const r = JSON.parse(j.report_json);
console.log("=== التقرير النهائي — nemotron على كراسة 260839005042 ===");
console.log("كفاية الأدلة:", r.evidenceSufficiency, "| الثقة:", r.confidence);
console.log("معرفات الكفاية:", (r.sufficiencyEvidenceIds ?? []).join(", "));
const sec = (title, key) => {
  const items = r[key] ?? [];
  console.log("\n-- " + title + " --");
  for (const s of items) console.log("•", String(s.statement ?? "").replace(/\s+/g, " ").slice(0, 170));
};
sec("نطاق العمل", "scopeOfWork");
sec("كميات حرجة", "criticalQuantities");
sec("شروط أهلية", "eligibilityRequirements");
sec("مخاطر تعاقدية", "contractualRisks");
sec("نقاط غير واضحة", "unclearItems");
