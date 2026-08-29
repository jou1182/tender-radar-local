// محرك التحليل المحلي — P4-A0.
// ينسق: fixtureId مغلق ← قراءة آمنة ← استخراج ← تقسيم ← مزود ← تحقق صيغة ← حفظ.
// لا يقبل مسار ملف من العميل إطلاقًا، ولا يلمس قاعدة الإنتاج خارج ما يحقنه المنشئ،
// ولا يجري أي اتصال خارجي؛ Ollama المحلي لا يعمل إلا بتفعيل صريح.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { analysisFixtures, findAnalysisFixture } from "./analysis-fixtures.mjs";
import { defaultMaxFileBytes, extractAnalysisDocument, resolveAnalysisPath, supportedDocumentTypes } from "./analysis-documents.mjs";
import { chunkAnalysisDocument } from "./analysis-chunking.mjs";
import {
  analysisPromptVersion,
  analysisReportSchemaVersion,
  assertValidAnalysisReport,
  normalizeReportEvidenceIds,
  verifyReportGrounding,
} from "./analysis-report.mjs";
import { assertLoopbackOllamaHost, createAnalysisProvider, readAnalysisAiConfig } from "./analysis-providers.mjs";
import { resolveAttachmentStoragePath } from "./attachment-storage.mjs";

function engineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createAnalysisEngine({
  repository,
  fixtureRoot,
  trustedStoreRoot,
  env = {},
  fetchFn,
  readFileFn = readFile,
  maxFileBytes = Number(env.RADAR_ANALYSIS_MAX_FILE_MB) > 0
    ? Number(env.RADAR_ANALYSIS_MAX_FILE_MB) * 1024 * 1024
    : defaultMaxFileBytes,
}) {
  if (!repository) throw engineError("ANALYSIS_CONFIG", "محرك التحليل يحتاج مستودع SQLite.");
  if (!fixtureRoot) throw engineError("ANALYSIS_CONFIG", "محرك التحليل يحتاج جذر fixtures.");

  function listFixtures() {
    return analysisFixtures.map(({ fixtureId, title, documentType, tenderReference }) => ({ fixtureId, title, documentType, tenderReference }));
  }

  // حالات الصحة الأربع: stub / disabled / configured-unverified / available|unavailable.
  // الجسّ (probe) اختياري ولا يحدث إلا بطلب صريح، بمهلة قصيرة وبلا إعادة محاولة.
  async function health({ probe = false } = {}) {
    const config = readAnalysisAiConfig(env);
    let status = "stub";
    if (config.provider === "ollama") {
      if (!config.enabled) status = "disabled";
      else if (!probe) status = "configured-unverified";
      else {
        try {
          const host = assertLoopbackOllamaHost(config.ollamaHost);
          const fetcher = fetchFn || globalThis.fetch;
          const response = await fetcher(`${host}/api/tags`, { signal: AbortSignal.timeout(1_500) });
          if (!response?.ok) {
            status = "unavailable";
          } else {
            // الفحص الفعلي: available فقط إذا كان النموذج المحدد مثبتًا فعلًا.
            // لا pull ولا أي تغيير تلقائي — قراءة /api/tags فقط.
            const body = await response.json().catch(() => null);
            const models = Array.isArray(body?.models) ? body.models : [];
            const installed = models.map((entry) => entry?.name || entry?.model).filter(Boolean);
            status = installed.includes(config.ollamaModel) ? "available" : "model-unavailable";
          }
        } catch {
          status = "unavailable";
        }
      }
    }
    return {
      provider: config.provider,
      aiEnabled: config.enabled,
      model: config.provider === "ollama" ? config.ollamaModel : null,
      status,
      promptVersion: analysisPromptVersion,
      outputSchemaVersion: analysisReportSchemaVersion,
      fixtures: listFixtures(),
    };
  }

  // إنشاء مهمة من fixtureId معروف فقط؛ أي مسار من العميل مرفوض في طبقة الـAPI قبل الوصول هنا.
  async function createJob({ fixtureId, now = new Date() }) {
    const fixture = findAnalysisFixture(fixtureId);
    if (!fixture) {
      throw engineError("ANALYSIS_FIXTURE_NOT_FOUND", `الـfixture غير معروف: ${String(fixtureId || "(فارغ)")}. اختر من قائمة fixtures الموثقة.`);
    }
    const safePath = resolveAnalysisPath(fixtureRoot, fixture.fileName);
    const buffer = await readFileFn(safePath);
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    const documentId = `doc-${randomUUID()}`;
    const document = extractAnalysisDocument({ documentId, fileName: fixture.fileName, buffer, maxBytes: maxFileBytes, applyRtlFix: false });
    repository.registerAnalysisDocument({
      id: documentId,
      tenderReference: fixture.tenderReference,
      documentType: document.documentType,
      originalFileName: fixture.fileName,
      localStoredName: fixture.fileName,
      checksum: document.checksum,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      fixtureId: fixture.fixtureId,
      now: nowIso,
    });
    const config = readAnalysisAiConfig(env);
    const jobId = `analysis-job-${randomUUID()}`;
    repository.createAnalysisJob({
      id: jobId,
      documentId,
      tenderReference: fixture.tenderReference,
      provider: config.provider,
      model: config.provider === "ollama" ? config.ollamaModel : null,
      promptVersion: analysisPromptVersion,
      outputSchemaVersion: analysisReportSchemaVersion,
      now: nowIso,
    });
    return repository.getAnalysisJob(jobId);
  }

  // ---------- P4-UAT1B: مستند موثوق محلي (المخزن الموثوق للمرفقات) ----------
  // إعادة استخدام حرفي لبوابة أسماء المخزن الموثوق: resolveAttachmentStoragePath
  // ترفض أي اسم ليس اسم ملف مخزَّن عاديًا آمنًا (مسارات مطلقة، فواصل مسارات،
  // traversal، أسماء محجوزة، محارف غير آمنة لنظام Windows). لا نستخدم المسار
  // المُعاد منه — القواعد نفسها هي ما نعيد استخدامه كبوابة قبل أي بحث أو قراءة.
  function assertTrustedStoredName(localStoredName) {
    try {
      resolveAttachmentStoragePath(trustedStoreRoot, "000000000000", localStoredName);
    } catch (error) {
      if (error?.code === "INVALID_STORAGE_PATH" || error?.code === "INVALID_TENDER_REFERENCE") {
        throw engineError("DOCUMENT_PATH_NOT_ALLOWED", "اسم الملف المحلي غير مسموح؛ يُقبل اسم ملف مخزَّن عادي فقط داخل المخزن الموثوق.");
      }
      throw error;
    }
  }

  // بحث محصور داخل المخزن الموثوق فقط: مجلدات مراجع المنافسات (باسم مطابق لقاعدة
  // مرجع المنافسة) وملفات عادية تحمل الاسم المخزَّن الحرفي. لا يتبع غير الدلائل
  // والملفات العادية، ولا يخرج عن جذر المخزن، ولا يلمس أي مجلد خارجي إطلاقًا.
  async function findTrustedStoredFiles(localStoredName) {
    const root = path.resolve(String(trustedStoreRoot));
    let tenderDirs;
    try {
      tenderDirs = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const found = [];
    for (const tenderEntry of tenderDirs) {
      if (!tenderEntry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(tenderEntry.name)) continue;
      const files = await readdir(path.join(root, tenderEntry.name), { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || file.name !== localStoredName) continue;
        const resolved = path.resolve(root, tenderEntry.name, file.name);
        if (!resolved.startsWith(root + path.sep)) continue;
        found.push({ path: resolved, tenderReference: tenderEntry.name });
      }
    }
    return found;
  }

  // التحقق النهائي قبل أي إنشاء/تشغيل: الاسم موجود فعلًا في المخزن الموثوق،
  // ومحتواه الفعلي يطابق البصمة المتوقعة (إن طُلبت). أي غياب أو تباين يفشل
  // بصوت عالٍ بكود واضح قبل أي تسجيل مستند أو إنشاء مهمة.
  async function resolveTrustedStoreDocument({ localStoredName, expectedSha256 }) {
    if (!trustedStoreRoot) throw engineError("ANALYSIS_CONFIG", "المخزن الموثوق غير مكوَّن؛ يلزم trustedStoreRoot لقراءة مستند موثوق محلي.");
    assertTrustedStoredName(localStoredName);
    const found = await findTrustedStoredFiles(localStoredName);
    if (found.length === 0) {
      throw engineError("ANALYSIS_DOCUMENT_NOT_IN_TRUSTED_STORE", `المستند غير موجود في المخزن الموثوق: ${String(localStoredName)}.`);
    }
    const verified = [];
    for (const candidate of found) {
      const buffer = await readFileFn(candidate.path);
      const actualSha256 = createHash("sha256").update(buffer).digest("hex");
      if (expectedSha256 && actualSha256 !== expectedSha256) continue;
      verified.push({ ...candidate, buffer, sha256: actualSha256 });
    }
    if (verified.length === 0) {
      throw engineError("DOCUMENT_SHA256_MISMATCH", `SHA-256 للمستند لا يطابق البصمة المتوقعة: ${String(localStoredName)}.`);
    }
    if (verified.length > 1) {
      throw engineError("ANALYSIS_DOCUMENT_AMBIGUOUS", `اسم مخزَّن واحد يطابق أكثر من ملف داخل المخزن الموثوق: ${String(localStoredName)}.`);
    }
    return verified[0];
  }

  // إنشاء مهمة تحليل من مرجع مستند موثوق موجود فعلًا في المخزن الموثوق المحلي.
  // المرجع حصري: localStoredName + sha256 + originalFileName + documentType فقط —
  // لا يُقبل أي مسار أو محتوى من المتصل إطلاقًا، والمستند يجب أن يكون موجودًا
  // مسبقًا بمطابقة البصمة الحرفية قبل تسجيل أي مستند أو إنشاء أي مهمة، ثم يمر
  // عبر نفس خط الأنابيب المعتمد تمامًا (استخراج ← تقسيم ← مزود ← تحقق ← تأسيس).
  async function createJobFromStoredDocument({ localStoredName, sha256, originalFileName, documentType, now = new Date() }) {
    if (!trustedStoreRoot) throw engineError("ANALYSIS_CONFIG", "المخزن الموثوق غير مكوَّن؛ يلزم trustedStoreRoot لإنشاء مهمة من مستند موثوق محلي.");
    const storedName = String(localStoredName || "");
    const originalName = String(originalFileName || "");
    const referenceSha256 = String(sha256 || "").toLowerCase();
    if (!storedName) throw engineError("ANALYSIS_DOCUMENT_REFERENCE_INVALID", "مرجع المستند ناقص: localStoredName مطلوب.");
    if (!originalName) throw engineError("ANALYSIS_DOCUMENT_REFERENCE_INVALID", "مرجع المستند ناقص: originalFileName مطلوب.");
    if (!/^[a-f0-9]{64}$/.test(referenceSha256)) throw engineError("ANALYSIS_DOCUMENT_REFERENCE_INVALID", "مرجع المستند غير صالح: sha256 يجب أن يكون بصمة SHA-256 سداسية عشرية من 64 محرفًا.");
    if (!supportedDocumentTypes.includes(documentType)) {
      throw engineError("DOCUMENT_TYPE_NOT_SUPPORTED", `نوع المستند غير مدعوم: ${documentType}. المدعوم: PDF وXLSX وDOCX.`);
    }
    const stored = await resolveTrustedStoreDocument({ localStoredName: storedName, expectedSha256: referenceSha256 });
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
    const documentId = `doc-${randomUUID()}`;
    const document = extractAnalysisDocument({ documentId, fileName: originalName, buffer: stored.buffer, maxBytes: maxFileBytes });
    if (document.documentType !== documentType) {
      throw engineError("DOCUMENT_TYPE_MISMATCH", `نوع المستند المعلَن (${documentType}) لا يطابق المحتوى الفعلي (${document.documentType}).`);
    }
    repository.registerAnalysisDocument({
      id: documentId,
      tenderReference: stored.tenderReference,
      documentType: document.documentType,
      originalFileName: originalName,
      localStoredName: storedName,
      checksum: stored.sha256,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      fixtureId: "",
      now: nowIso,
      extractionMethod: document.extractionMethod ?? "pdfjs",
    });
    const config = readAnalysisAiConfig(env);
    const jobId = `analysis-job-${randomUUID()}`;
    repository.createAnalysisJob({
      id: jobId,
      documentId,
      tenderReference: stored.tenderReference,
      provider: config.provider,
      model: config.provider === "ollama" ? config.ollamaModel : null,
      promptVersion: analysisPromptVersion,
      outputSchemaVersion: analysisReportSchemaVersion,
      now: nowIso,
    });
    return repository.getAnalysisJob(jobId);
  }

  function getJob(id) {
    return repository.getAnalysisJob(String(id || ""));
  }

  async function runJob(id, { now = new Date() } = {}) {
    const job = repository.getAnalysisJob(String(id || ""));
    if (!job) throw engineError("ANALYSIS_JOB_NOT_FOUND", "مهمة التحليل غير موجودة.");
    if (job.jobStatus !== "queued") {
      throw engineError("ANALYSIS_JOB_NOT_RUNNABLE", `لا يمكن تشغيل مهمة بحالة ${job.jobStatus}؛ يُقبل queued فقط.`);
    }
    const startedAt = Date.now();
    const startedIso = (now instanceof Date ? now : new Date(now)).toISOString();
    // استيلاء ذري قبل أي عمل: متسابق ثانٍ يفشل هنا قبل إنشاء المزود أو استدعائه.
    if (!repository.claimAnalysisJob(job.id, startedIso)) {
      throw engineError("ANALYSIS_JOB_NOT_RUNNABLE", "مهمة التحليل استولى عليها مشغّل آخر بالفعل.");
    }
    // إنشاء المزود داخل try بعد الحجز: فشل الإعداد (مضيف غير موثوق مثلًا) يحول المهمة
    // إلى failed بسجل errorCode واضح — لا تبقى extracting ولا يحدث أي اتصال غير موثوق.
    let provider = null;
    try {
      provider = createAnalysisProvider({ env, fetchFn });
      // المستند الموثوق المحلي (fixtureId فارغ) يُقرأ من المخزن الموثوق ويُتحقق
      // من بصمته المسجلة؛ أما fixtures فتُقرأ من جذرها المحدد كما كان دون تغيير.
      const isStoredDocument = !job.document.fixtureId;
      const fixture = isStoredDocument ? null : findAnalysisFixture(job.document.fixtureId);
      if (!isStoredDocument && !fixture) throw engineError("ANALYSIS_FIXTURE_NOT_FOUND", "الـfixture المرتبط بالمستند لم يعد معروفًا.");
      const storedDocument = isStoredDocument
        ? await resolveTrustedStoreDocument({ localStoredName: job.document.localStoredName, expectedSha256: job.document.checksum })
        : null;
      const safePath = isStoredDocument ? storedDocument.path : resolveAnalysisPath(fixtureRoot, fixture.fileName);
      const buffer = isStoredDocument ? storedDocument.buffer : await readFileFn(safePath);
      const document = extractAnalysisDocument({
        documentId: job.document.id,
        fileName: job.document.originalFileName,
        buffer,
        maxBytes: maxFileBytes,
      });
      if (document.checksum !== job.document.checksum) {
        throw engineError("ANALYSIS_CHECKSUM_MISMATCH", "تغيّر محتوى الـfixture منذ تسجيل المهمة؛ أعد إنشاء المهمة.");
      }
      const chunks = chunkAnalysisDocument(document);
      repository.updateAnalysisJobStatus(job.id, { jobStatus: "analyzing" });
      const rawReport = await provider.analyze({ document, chunks, promptVersion: analysisPromptVersion });
      const { _meta, ...providerReport } = rawReport || {};
      // تطبيع معرفات الأدلة بنطاق المهمة قبل التحقق: لا تصادم مفاتيح بين المهمات،
      // والمراجع الوهمية تبقى ظاهرة فيسقطها المدقق ثم فاحص التأسيس.
      const report = normalizeReportEvidenceIds(providerReport, job.id);
      assertValidAnalysisReport(report);
      verifyReportGrounding(report, document, chunks);
      repository.saveAnalysisResult(job.id, {
        report,
        modelRun: {
          provider: provider.name,
          model: provider.model,
          status: "succeeded",
          durationMs: Number(_meta?.durationMs) || Date.now() - startedAt,
          promptVersion: analysisPromptVersion,
          outputSchemaVersion: analysisReportSchemaVersion,
        },
        now: new Date().toISOString(),
      });
      return repository.getAnalysisJob(job.id);
    } catch (error) {
      const code = error?.code || "ANALYSIS_FAILED";
      repository.updateAnalysisJobStatus(job.id, {
        jobStatus: "failed",
        errorCode: code,
        errorMessage: error?.message || "فشل غير معروف أثناء التحليل.",
        finishedAt: new Date().toISOString(),
      });
      // سجل التشغيل: المزود والنموذج والمدة والحالة فقط — بلا أي نص من الطلب أو الاستجابة.
      // عند فشل إنشاء المزود نفسه تُسجل قيم الإعداد دون أي اتصال.
      const failedConfig = readAnalysisAiConfig(env);
      repository.recordModelRun(job.id, {
        provider: provider?.name || failedConfig.provider,
        model: provider ? provider.model : (failedConfig.provider === "ollama" ? failedConfig.ollamaModel : null),
        status: "failed",
        durationMs: Date.now() - startedAt,
        promptVersion: analysisPromptVersion,
        outputSchemaVersion: analysisReportSchemaVersion,
        errorCode: code,
        now: new Date().toISOString(),
      });
      throw error;
    }
  }

  return { listFixtures, health, createJob, createJobFromStoredDocument, getJob, runJob };
}
