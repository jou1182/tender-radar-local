// P5-B1: تحليل حي لكراسة منزّلة عبر createJobFromStoredDocument + qwen2.5:14b
// موافقة المالك 2026-08-28: تجربة تحليل حية واحدة على «نطاق العمل.pdf» المنزّل (بعد إصلاح CMap).
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runTrustedDocumentAnalysis } from "../../scripts/lib/trusted-document-cli.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..", "radar");
const storedPath = path.join(projectRoot, ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");

const sha = createHash("sha256").update(await readFile(storedPath)).digest("hex");
console.log("مستند موثوق:", storedPath.slice(-45), "| sha:", sha.slice(0, 16) + "...");

const env = {
  ...process.env,
  RADAR_AI_ENABLED: "true",
  RADAR_AI_PROVIDER: "ollama",
  OLLAMA_MODEL: "qwen2.5:14b",
  OLLAMA_URL: "http://127.0.0.1:11434",
};

console.log("\n=== بدء التحليل الحي بـ qwen2.5:14b (بعد إصلاح CMap) ===");
const t0 = Date.now();
try {
  const result = await runTrustedDocumentAnalysis({
    projectRoot,
    localStoredName: "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf",
    sha256: sha,
    originalFileName: "نطاق العمل.pdf",
    documentType: "pdf",
    env,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n=== اكتمل في ${secs} ثانية ===`);
  const report = result.report ?? result;
  console.log("preliminaryDecision:", report.preliminaryDecision);
  console.log("confidence:", report.confidence);
  const evidence = report.evidenceCatalog ?? [];
  console.log("أدلة:", evidence.length);
  for (const e of evidence.slice(0, 6)) {
    console.log("  -", (e.excerpt || "").replace(/\s+/g, " ").slice(0, 90));
  }
  const unc = report.unclearItems ?? [];
  console.log("نقاط غير واضحة:", unc.length);
  for (const u of unc.slice(0, 4)) console.log("  -", (u.statement || "").replace(/\s+/g, " ").slice(0, 100));
} catch (error) {
  const secs = Math.round((Date.now() - t0) / 1000);
  console.error(`\n=== فشل بعد ${secs} ثانية ===`);
  console.error("code:", error.code);
  console.error("message:", error.message?.slice(0, 300));
}
