// محوّلات التنزيل لـP3-B0.
// DisabledProductionDownloadAdapter: المحوّل الوحيد في التشغيل الحقيقي — كل محاولة تعيد DOWNLOAD_ADAPTER_DISABLED.
// FakeDownloadAdapter: محاكٍ للاختبارات فقط، يكتب ملفات placeholder صغيرة داخل مجلد مؤقت، بلا شبكة ولا متصفح.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function createDisabledProductionDownloadAdapter() {
  return {
    kind: "disabled-production",
    async execute() {
      const error = new Error("التنفيذ الحي للتنزيل غير مفعّل في P3-B0؛ كتابة الملفات تتاح بعد تفعيل محوّل الإنتاج في مرحلة لاحقة بموافقة منفصلة.");
      error.code = "DOWNLOAD_ADAPTER_DISABLED";
      throw error;
    },
  };
}

export function createFakeDownloadAdapter({ resolvePath } = {}) {
  if (typeof resolvePath !== "function") {
    throw new Error("FakeDownloadAdapter يحتاج resolvePath من وحدة التخزين الآمنة.");
  }
  const executed = [];
  return {
    kind: "fake",
    executed,
    async execute(job) {
      const written = [];
      for (const file of job.manifest.files) {
        const target = resolvePath(file.displayName);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `FAKE-DOWNLOAD-PLACEHOLDER\njob=${job.id}\ntender=${job.manifest.tenderReference}\nfile=${file.displayName}\n`, "utf8");
        written.push(target);
      }
      executed.push({ jobId: job.id, files: written });
      return { status: "complete", files: written };
    },
  };
}
