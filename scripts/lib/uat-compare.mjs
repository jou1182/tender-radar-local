// P5-B1-E: مقارنة قياسية على نفس الكراسة: qwen2.5:14b مقابل nemotron (نفس خط الأنابيب)
// موافقة المالك 2026-08-28 تشمل تجربة التحليل الحية على «نطاق العمل.pdf».
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runTrustedDocumentAnalysis } from "../../scripts/lib/trusted-document-cli.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..", "radar");
const storedPath = path.join(projectRoot, ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");
const sha = createHash("sha256").update(await readFile(storedPath)).digest("hex");
const localStoredName = "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf";

const model = process.argv[2] || "qwen2.5:14b";
const env = {
  ...process.env,
  RADAR_AI_ENABLED: "true",
  RADAR_AI_PROVIDER: "ollama",
  OLLAMA_MODEL: model,
  OLLAMA_URL: "http://127.0.0.1:11434",
};

console.log(`\n═══ ${model} ═══`);
const t0 = Date.now();
try {
  const result = await runTrustedDocumentAnalysis({
    projectRoot, localStoredName, sha256: sha,
    originalFileName: "نطاق العمل.pdf", documentType: "pdf", env,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const report = result.report ?? result;
  const evidence = report.evidenceCatalog ?? [];
  console.log(`✓ اكتمل في ${secs}ث | evidenceSufficiency: ${report.evidenceSufficiency} | confidence: ${report.confidence} | أدلة: ${evidence.length}`);
  const sample = (report.scopeOfWork ?? [])[0]?.statement ?? "";
  console.log("عينة scopeOfWork:", JSON.stringify(sample.replace(/\s+/g, " ").slice(0, 130)));
} catch (error) {
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`✖ فشل في ${secs}ث | code: ${error.code}`);
  console.log("  message:", (error.message || "").slice(0, 150));
}
