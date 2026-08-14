// موجه API التحليل المحلي — P4-A0.
// نقاط مغلقة: صحة المحرك، إنشاء مهمة من fixtureId معروف فقط، قراءة مهمة، تشغيل مهمة.
// لا يقبل أي مسار ملف من العميل إطلاقًا، ولا يغيّر مسارات المزامنة أو التنزيل.
export function createAnalysisApiHandler({ engine }) {
  const send = (status, payload) => ({ status, payload });
  const fail = (status, error, message) => send(status, { ok: false, error, message });

  return async function handleAnalysisRequest({ method, pathname, body = {} }) {
    if (method === "GET" && pathname === "/analysis/health") {
      return send(200, { ok: true, ...(await engine.health({ probe: true })) });
    }

    if (method === "POST" && pathname === "/analysis/jobs") {
      // مرفوض قطعًا: أي محاولة لتمرير مسار أو محتوى ملف من العميل.
      if (body && (body.path || body.filePath || body.file || body.content || body.fileName)) {
        return fail(400, "ANALYSIS_PATH_NOT_ALLOWED", "لا يُقبل أي مسار أو ملف من العميل؛ أرسل fixtureId من القائمة الموثقة فقط.");
      }
      try {
        const job = await engine.createJob({ fixtureId: body?.fixtureId });
        return send(201, { ok: true, job });
      } catch (error) {
        if (error?.code === "ANALYSIS_FIXTURE_NOT_FOUND") return fail(404, error.code, error.message);
        if (error?.code === "DOCUMENT_PATH_NOT_ALLOWED") return fail(400, error.code, error.message);
        if (["DOCUMENT_TYPE_NOT_SUPPORTED", "DOCUMENT_MIME_MISMATCH", "DOCUMENT_TOO_LARGE", "DOCUMENT_EMPTY", "DOCUMENT_CORRUPT", "DOCUMENT_NO_TEXT"].includes(error?.code)) {
          return fail(422, error.code, error.message);
        }
        throw error;
      }
    }

    const jobMatch = pathname.match(/^\/analysis\/jobs\/([^/]+)(\/run)?$/);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      if (method === "GET" && !jobMatch[2]) {
        const job = engine.getJob(jobId);
        if (!job) return fail(404, "ANALYSIS_JOB_NOT_FOUND", "مهمة التحليل غير موجودة.");
        return send(200, { ok: true, job });
      }
      if (method === "POST" && jobMatch[2]) {
        try {
          const job = await engine.runJob(jobId);
          return send(200, { ok: true, job });
        } catch (error) {
          if (error?.code === "ANALYSIS_JOB_NOT_FOUND") return fail(404, error.code, error.message);
          if (error?.code === "ANALYSIS_JOB_NOT_RUNNABLE") return fail(409, error.code, error.message);
          if (["AI_PROVIDER_DISABLED", "AI_UNTRUSTED_HOST", "AI_PROVIDER_UNAVAILABLE"].includes(error?.code)) {
            return fail(503, error.code, error.message);
          }
          if (["AI_OUTPUT_INVALID", "ANALYSIS_OUTPUT_INVALID", "ANALYSIS_GROUNDING_FAILED"].includes(error?.code)) {
            return fail(502, error.code, error.message);
          }
          if (error?.code === "ANALYSIS_CHECKSUM_MISMATCH") return fail(409, error.code, error.message);
          if (String(error?.code || "").startsWith("DOCUMENT_")) return fail(422, error.code, error.message);
          throw error;
        }
      }
    }
    return null;
  };
}
