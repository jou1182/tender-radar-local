// أداتا P4-UAT2A: وضع مستند موثوق يدويًا وتشغيل تحليل عليه.
// كود فقط — بلا أي تشغيل حي وبلا مستند حقيقي؛ القراءة/الكتابة محلية فقط.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRadarRepository } from "./radar-repository.mjs";
import { createAnalysisEngine } from "./analysis-engine.mjs";
import {
  attachmentStorageRoot,
  attachmentTenderDir,
  resolveAttachmentStoragePath,
} from "./attachment-storage.mjs";

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// يضع مستندًا موثوقًا يدويًا في المخزن الموثوق المحلي ويُعيد مرجعًا جاهزًا
// للتشغيل لاحقًا عبر runTrustedDocumentAnalysis. لا شبكة ولا Chrome ولا Etimad.
export async function placeTrustedDocument({ projectRoot, tenderReference, sourceFilePath, displayName }) {
  attachmentTenderDir(projectRoot, tenderReference);
  const storedPath = resolveAttachmentStoragePath(projectRoot, tenderReference, displayName);
  const content = await readFile(sourceFilePath);
  const localStoredName = path.basename(storedPath);
  try {
    await mkdir(path.dirname(storedPath), { recursive: true });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    await writeFile(storedPath, content, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw cliError(
        "DOCUMENT_ALREADY_EXISTS",
        `الملف الوجهة موجود مسبقًا: ${storedPath}. لا يُستبدل تلقائيًا — احذفه يدويًا أولًا إن أردت الاستبدال.`,
      );
    }
    throw error;
  }
  const copied = await readFile(storedPath);
  const sha256 = createHash("sha256").update(copied).digest("hex");
  return {
    storedPath,
    localStoredName,
    tenderReference,
    sha256,
    sizeBytes: copied.length,
  };
}

// يشغّل تحليلًا على مستند موثوق موجود فعلًا في المخزن الموثوق المحلي عبر
// createJobFromStoredDocument ثم runJob — بدون أي منطق إعادة محاولة تلقائية؛
// أي خطأ يُرمى كما هو للمستدعي.
export async function runTrustedDocumentAnalysis({ projectRoot, localStoredName, sha256, originalFileName, documentType, env = process.env }) {
  const repository = await createRadarRepository({ projectRoot });
  try {
    const engine = createAnalysisEngine({
      repository,
      fixtureRoot: path.join(projectRoot, "analysis-fixtures"),
      trustedStoreRoot: attachmentStorageRoot(projectRoot),
      env,
    });
    const job = await engine.createJobFromStoredDocument({ localStoredName, sha256, originalFileName, documentType });
    return await engine.runJob(job.id);
  } finally {
    repository.close();
  }
}
