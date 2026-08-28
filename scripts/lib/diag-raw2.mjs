// P5-B1-D: طباعة مخرجات qwen2.5 الخام على كتالوج الكراسة الحقيقية
import path from "node:path";
import { readFile } from "node:fs/promises";
import { extractAnalysisDocument } from "./analysis-documents.mjs";
import { buildEvidenceCandidateCatalog } from "./analysis-evidence-candidates.mjs";
import { buildModelSelectionPrompt, buildModelSelectionSchema } from "./analysis-model-selection.mjs";

// استخدم chunking الرسمي
const chunkingMod = await import("./analysis-chunking.mjs");
const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..", "radar");
const storedPath = path.join(projectRoot, ".radar-data", "attachments", "260839005042", "67aeddf236cf577202c0ca2de15472866abda9e44b59b01887ec44c0a8065260.pdf");
const buffer = await readFile(storedPath);
const document = extractAnalysisDocument({ documentId: "diag", fileName: "نطاق العمل.pdf", buffer, maxBytes: 50 * 1024 * 1024 });

const chunks = chunkingMod.buildAnalysisChunks
  ? chunkingMod.buildAnalysisChunks({ document })
  : chunkingMod.buildChunks ? chunkingMod.buildChunks({ document }) : null;
console.log("chunk fn:", Object.keys(chunkingMod).join(","));

const catalog = buildEvidenceCandidateCatalog({ document, chunks });
console.log("candidates:", catalog.candidates.length, "| excluded:", catalog.excludedCount);
console.log("أول 3 مرشحين:");
for (const c of catalog.candidates.slice(0, 3)) {
  console.log("  -", c.candidateId, "|", JSON.stringify(c.excerpt.slice(0, 70)));
}
const prompt = buildModelSelectionPrompt({ document, catalog });
const schema = buildModelSelectionSchema(catalog.candidates);

const resp = await fetch("http://127.0.0.1:11434/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "qwen2.5:14b", prompt, stream: false, format: schema, options: { temperature: 0 }, think: false }),
});
const body = await resp.json();
console.log("\n=== RAW response ===");
console.log(String(body?.response || "").slice(0, 1200));
