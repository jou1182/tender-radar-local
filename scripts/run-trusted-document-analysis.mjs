// غلاف CLI رقيق لتشغيل تحليل على مستند موثوق موجود فعلًا في المخزن الموثوق المحلي.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTrustedDocumentAnalysis } from "./lib/trusted-document-cli.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [localStoredName, sha256, originalFileName, documentType] = process.argv.slice(2);

function usage() {
  console.error("الاستخدام: node scripts/run-trusted-document-analysis.mjs <localStoredName> <sha256> <originalFileName> <documentType>");
  console.error("مثال: node scripts/run-trusted-document-analysis.mjs <64-حرف-هكس> <originalName.pdf> pdf");
}

if (!localStoredName || !sha256 || !originalFileName || !documentType) {
  usage();
  process.exit(1);
}

try {
  const job = await runTrustedDocumentAnalysis({
    projectRoot: scriptRoot,
    localStoredName,
    sha256,
    originalFileName,
    documentType,
    env: process.env,
  });
  console.log(JSON.stringify(job, null, 2));
} catch (error) {
  console.error(`خطأ: ${error?.message || error}`);
  process.exitCode = 1;
}
