import test from "node:test";
import assert from "node:assert/strict";
import { extractAnalysisDocument } from "../scripts/lib/analysis-documents.mjs";

// Synthetic one-page PDFs only. No real attachments, DB, tools or network.
function pdf(stream = "", { filter = "", extraObjects = [] } = {}) {
  const data = Buffer.isBuffer(stream) ? stream : Buffer.from(stream, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Length ${data.length} ${filter} >>\nstream\n`), data, Buffer.from("\nendstream")]),
    ...extraObjects,
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from("\nendobj\n"));
  }
  const startxref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${startxref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function extract(buffer, execFile, options = {}) {
  return extractAnalysisDocument({
    documentId: "offline",
    fileName: "synthetic.pdf",
    buffer,
    applyRtlFix: false,
    execFile,
    ...options,
  });
}

const goodText = "يلتزم المقاول بتقديم ضمان حسن التنفيذ خلال عشرة أيام";

test("empty built-in PDF extraction reaches the first acceptable fallback", () => {
  const calls = [];
  // execFileSync الحقيقي متزامن، ومع `encoding: "utf8"` يعيد نصًا (سلسلة).
  const doc = extract(pdf(), (command) => {
    calls.push(command);
    return goodText;
  });
  assert.deepEqual(calls, ["pdftotext"]);
  assert.equal(doc.extractionMethod, "poppler-fallback");
  assert.equal(doc.blocks[0].text, goodText);
  assert.deepEqual(doc.extractionAttempts, [
    { method: "pdfjs", outcome: "no_text", code: "DOCUMENT_NO_TEXT", message: "لم يُستخرج أي نص من ملف PDF." },
    { method: "poppler-fallback", outcome: "accepted", code: null },
  ]);
});

test("fragmented poppler output is rejected; chain moves to pymupdf", () => {
  const calls = [];
  // poppler يُخرج حروفًا مفردة (تجزئة) → يُرفض. pymupdf يُخرج JSON نصًا سليمًا → يُعتمد.
  const doc = extract(pdf(), (command) => {
    calls.push(command);
    if (command === "pdftotext") return "ا\nو\nي\nت\n";
    return '{"pages":[["يلتزم المقاول بتقديم ضمان حسن التنفيذ خلال عشرة أيام"]]}';
  });
  assert.deepEqual(calls, ["pdftotext", "python3"]);
  assert.equal(doc.extractionMethod, "pymupdf-fallback");
  assert.equal(doc.blocks[0].text, "يلتزم المقاول بتقديم ضمان حسن التنفيذ خلال عشرة أيام");
  assert.deepEqual(doc.extractionAttempts, [
    { method: "pdfjs", outcome: "no_text", code: "DOCUMENT_NO_TEXT", message: "لم يُستخرج أي نص من ملف PDF." },
    { method: "pymupdf-fallback", outcome: "accepted", code: null },
  ]);
});

test("all fallbacks failing rethrows the original DOCUMENT_NO_TEXT", () => {
  const doc = (() => {
    try {
      return extract(pdf(), () => { throw new Error("pgrep: no tesseract"); });
    } catch (error) {
      return error;
    }
  })();
  assert.equal(doc.code, "DOCUMENT_NO_TEXT");
  assert.match(doc.message, /لم يُستخرج أي نص من ملف PDF/);
});
