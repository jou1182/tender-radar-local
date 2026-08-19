// غلاف CLI رقيق لوضع مستند موثوق يدويًا في المخزن الموثوق المحلي.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeTrustedDocument } from "./lib/trusted-document-cli.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [tenderReference, sourceFilePath, displayName] = process.argv.slice(2);

function usage() {
  console.error("الاستخدام: node scripts/place-trusted-document.mjs <tenderReference> <sourceFilePath> <displayName>");
  console.error("مثال: node scripts/place-trusted-document.mjs 260000009999 ./local-brochure.pdf brochure.pdf");
}

if (!tenderReference || !sourceFilePath || !displayName) {
  usage();
  process.exit(1);
}

try {
  const result = await placeTrustedDocument({ projectRoot: scriptRoot, tenderReference, sourceFilePath, displayName });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`خطأ: ${error?.message || error}`);
  process.exitCode = 1;
}
