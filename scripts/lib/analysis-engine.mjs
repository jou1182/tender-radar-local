// محرك التحليل المحلي — P4-A0.
// ينسق: fixtureId مغلق ← قراءة آمنة ← استخراج ← تقسيم ← مزود ← تحقق صيغة ← حفظ.
// لا يقبل مسار ملف من العميل إطلاقًا، ولا يلمس قاعدة الإنتاج خارج ما يحقنه المنشئ،
// ولا يجري أي اتصال خارجي؛ Ollama المحلي لا يعمل إلا بتفعيل صريح.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { analysisFixtures, findAnalysisFixture } from "./analysis-fixtures.mjs";
import { defaultMaxFileBytes, extractAnalysisDocument, resolveAnalysisPath } from "./analysis-documents.mjs";
import { chunkAnalysisDocument } from "./analysis-chunking.mjs";
import {
  analysisPromptVersion,
  analysisReportSchemaVersion,
  assertValidAnalysisReport,
  normalizeReportEvidenceIds,
  verifyReportGrounding,
} from "./analysis-report.mjs";
import { assertLoopbackOllamaHost, createAnalysisProvider, readAnalysisAiConfig } from "./analysis-providers.mjs";

function engineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createAnalysisEngine({
  repository,
  fixtureRoot,
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
    const document = extractAnalysisDocument({ documentId, fileName: fixture.fileName, buffer, maxBytes: maxFileBytes });
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
      const fixture = findAnalysisFixture(job.document.fixtureId);
      if (!fixture) throw engineError("ANALYSIS_FIXTURE_NOT_FOUND", "الـfixture المرتبط بالمستند لم يعد معروفًا.");
      const safePath = resolveAnalysisPath(fixtureRoot, job.document.localStoredName || fixture.fileName);
      const buffer = await readFileFn(safePath);
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

  return { listFixtures, health, createJob, getJob, runJob };
}
