// P3-B1A: بوابة تنفيذ محكومة لمنافسة مجانية واحدة وملف واحد.
// لا تحتوي هذه الوحدة driver حيًا أو selectors لمنصة اعتماد. يضاف driver بعد فحص P3-B1B فقط.
import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { allowedDownloadExtensions, fileExtension, hashDownloadManifest, maxFileBytes } from "./download-gate.mjs";
import { resolveAttachmentStoragePath } from "./attachment-storage.mjs";

export const liveEnabledEnvName = "RADAR_LIVE_DOWNLOAD_ENABLED";
export const liveKillEnvName = "RADAR_LIVE_DOWNLOAD_KILL";
export const liveAllowlistEnvNames = {
  tenderReference: "RADAR_LIVE_DOWNLOAD_TENDER_REF",
  fileName: "RADAR_LIVE_DOWNLOAD_FILE_NAME",
  manifestSha256: "RADAR_LIVE_DOWNLOAD_MANIFEST_SHA256",
};
export const liveKillSwitchFileName = "live-acquisition.stop";
export const quarantineDirectoryName = "quarantine";
export const liveMaxFileBytes = maxFileBytes;
export const liveTimeoutMs = 60_000;
export const livePreflightTimeoutMs = 15_000;

export function liveAcquisitionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readLiveAcquisitionConfig(env = process.env) {
  const tenderReference = String(env[liveAllowlistEnvNames.tenderReference] || "").trim();
  const fileName = String(env[liveAllowlistEnvNames.fileName] || "").normalize("NFC").trim();
  const manifestSha256 = String(env[liveAllowlistEnvNames.manifestSha256] || "").trim().toLowerCase();
  return {
    enabled: env[liveEnabledEnvName] === "true",
    killSwitchEngaged: env[liveKillEnvName] === "true",
    tenderReference,
    fileName,
    manifestSha256,
    allowlistComplete: Boolean(tenderReference && fileName && /^[a-f0-9]{64}$/.test(manifestSha256)),
  };
}

export function liveKillSwitchPath(privateDir) {
  return path.join(String(privateDir), liveKillSwitchFileName);
}

export async function isLiveKillSwitchEngaged({ privateDir, env = process.env } = {}) {
  if (readLiveAcquisitionConfig(env).killSwitchEngaged) return true;
  try {
    await stat(liveKillSwitchPath(privateDir));
    return true;
  } catch (error) {
    // نفشل إلى الوضع الآمن إذا تعذر فحص ملف الإيقاف لسبب غير عدم وجوده.
    return error?.code !== "ENOENT";
  }
}

export async function engageLiveKillSwitch(privateDir) {
  await mkdir(String(privateDir), { recursive: true });
  const handle = await open(liveKillSwitchPath(privateDir), "w");
  try {
    await handle.writeFile(`engaged-at=${new Date().toISOString()}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return liveKillSwitchPath(privateDir);
}

export function assertManifestMatchesLiveAllowlist({ manifest, config }) {
  const mismatch = (message) => liveAcquisitionError("LIVE_ALLOWLIST_MISMATCH", message);
  if (!manifest || !Array.isArray(manifest.files)) throw mismatch("manifest غير موجود أو تالف.");
  if (manifest.tenderReference !== config.tenderReference) throw mismatch("مرجع المنافسة خارج قائمة السماح.");
  if (manifest.files.length !== 1) throw mismatch("يسمح P3-B1 بملف واحد فقط.");
  if (manifest.files[0].displayName !== config.fileName) throw mismatch("اسم الملف خارج قائمة السماح.");
  if (hashDownloadManifest(manifest) !== config.manifestSha256) throw mismatch("بصمة manifest لا تطابق قائمة السماح.");
  return true;
}

export function assertTrustedTenderUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw liveAcquisitionError("LIVE_UNTRUSTED_URL", "رابط تفاصيل المنافسة غير صالح.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "tenders.etimad.sa" || !parsed.pathname.toLowerCase().startsWith("/tender/")) {
    throw liveAcquisitionError("LIVE_UNTRUSTED_URL", "التنفيذ الحي مقيد بصفحات Tender على tenders.etimad.sa فقط.");
  }
  return parsed.href;
}

export function assertLivePreconditions({ tender, displayName }) {
  const fail = (message) => liveAcquisitionError("LIVE_PRECHECK_FAILED", message);
  // P5-B0PRE v2 (قرار المالك): قيمة الكراسة معلوماتية بحتة — لا شرط صفر ولا شرط تحقق
  // تفصيلي للرسوم على مسار التنزيل الحي. الحواجز الأمنية الحقيقية: الملف مرصود،
  // إتاحته ظاهرة، والموافقة البشرية الصريحة (عبارة + بصمة manifest) كما هي.
  if (!tender) throw fail("المنافسة غير موجودة في SQLite.");
  const meta = (tender.attachmentsMeta || []).find((candidate) => candidate.displayName === displayName);
  if (!meta) throw fail(`الملف ليس ضمن المرفقات المرصودة: ${displayName}`);
  if (meta.remoteVisible !== true) {
    throw fail("الملف غير ظاهر في صفحة المنافسة الآن.");
  }
  if (meta.availability === "restricted") {
    throw fail("الملف مقيّد ولا يمكن طلب تنزيله.");
  }
  return meta;
}

export function assertApprovalReady({ approval, manifest, now = new Date() }) {
  if (!approval) throw liveAcquisitionError("APPROVAL_NOT_FOUND", "الموافقة غير موجودة.");
  if (approval.status !== "approved") throw liveAcquisitionError(`APPROVAL_${String(approval.status || "INVALID").toUpperCase()}`, "الموافقة ليست صالحة للتنفيذ.");
  if (!approval.expiresAt || Date.parse(approval.expiresAt) <= (now instanceof Date ? now.getTime() : Date.parse(now))) {
    throw liveAcquisitionError("APPROVAL_EXPIRED", "انتهت صلاحية الموافقة.");
  }
  if (approval.tenderReference !== manifest.tenderReference || approval.scopeHash !== hashDownloadManifest(manifest)) {
    throw liveAcquisitionError("APPROVAL_SCOPE_MISMATCH", "الموافقة لا تطابق المنافسة والملف المحددين.");
  }
  return true;
}

const unsafeTriggerPattern = /شراء|دفع|سداد|انضمام|انضم|تقديم\s*العرض|تقديم\s*عرض|purchase|payment|checkout|submit\s*offer|join\s*tender|buy\s*now/i;

export function assertSafeDownloadTrigger(elementInfo = {}) {
  const haystack = [elementInfo.text, elementInfo.href, elementInfo.ariaLabel].map((part) => String(part || "")).join("\n");
  if (unsafeTriggerPattern.test(haystack)) throw liveAcquisitionError("LIVE_UNSAFE_ELEMENT", "العنصر يشير إلى إجراء مالي أو مشاركة في المنافسة.");
  return true;
}

function safeToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function quarantineJobDirectory(privateDir, jobId) {
  return path.join(String(privateDir), quarantineDirectoryName, safeToken(jobId));
}

export function quarantinePathFor(privateDir, jobId, displayName) {
  return path.join(quarantineJobDirectory(privateDir, jobId), `${safeToken(displayName)}.part`);
}

const ole2Signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const zipSignature = [0x50, 0x4b];
export const attachmentMagicSignatures = {
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]], zip: [zipSignature],
  "7z": [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], rar: [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  doc: [ole2Signature], xls: [ole2Signature], ppt: [ole2Signature],
  docx: [zipSignature], xlsx: [zipSignature], pptx: [zipSignature],
};

export const expectedAttachmentMimeTypes = {
  pdf: ["application/pdf"], zip: ["application/zip", "application/x-zip-compressed"],
  "7z": ["application/x-7z-compressed"], rar: ["application/vnd.rar", "application/x-rar-compressed"],
  doc: ["application/msword"], xls: ["application/vnd.ms-excel"], ppt: ["application/vnd.ms-powerpoint"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};

function bytesMatchPrefix(buffer, signature) {
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
}

export async function inspectQuarantinedFile({ quarantinePath, displayName, maxBytes = liveMaxFileBytes, contentType = null } = {}) {
  const fileStat = await stat(quarantinePath);
  if (fileStat.size === 0) throw liveAcquisitionError("LIVE_INSPECTION_FAILED", "الملف المحجوز فارغ.");
  if (fileStat.size > maxBytes) throw liveAcquisitionError("LIVE_FILE_TOO_LARGE", `تجاوز الملف الحد (${fileStat.size} بايت).`);
  const extension = fileExtension(displayName);
  if (!allowedDownloadExtensions.includes(extension)) throw liveAcquisitionError("EXTENSION_NOT_ALLOWED", `الصيغة غير مسموحة: ${displayName}`);
  const handle = await open(quarantinePath, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    if (!(attachmentMagicSignatures[extension] || []).some((signature) => bytesMatchPrefix(header, signature))) {
      throw liveAcquisitionError("LIVE_SIGNATURE_MISMATCH", `توقيع الملف لا يطابق ${extension}.`);
    }
    const mimeType = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (mimeType && mimeType !== "application/octet-stream" && !(expectedAttachmentMimeTypes[extension] || []).includes(mimeType)) {
      throw liveAcquisitionError("LIVE_MIME_MISMATCH", `نوع MIME لا يطابق ${extension}.`);
    }
    const sha256 = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      sha256.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { size: fileStat.size, sha256: sha256.digest("hex"), extension, mimeType: mimeType || null };
  } finally {
    await handle.close();
  }
}

async function cleanupJobQuarantine(jobDir) {
  await rm(jobDir, { recursive: true, force: true }).catch(() => {});
}

async function runBoundedPreflight(driver, args, timeoutMs) {
  const controller = new AbortController();
  let finished = false;
  const timeout = sleep(timeoutMs, undefined, { signal: controller.signal }).then(() => {
    if (finished) return null;
    controller.abort();
    throw liveAcquisitionError("LIVE_PREFLIGHT_TIMEOUT", "تجاوز فحص الهدف المدة المسموحة قبل بدء التنفيذ.");
  }).catch((error) => {
    if (error?.name === "AbortError" && finished) return null;
    throw error;
  });
  try {
    return await Promise.race([driver.preflight({ ...args, signal: controller.signal }), timeout]);
  } finally {
    finished = true;
    controller.abort();
  }
}

async function runBoundedAcquisition({ driver, args, quarantinePath, privateDir, env, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  let finished = false;
  const guard = (async () => {
    const started = Date.now();
    while (!finished) {
      if (await isLiveKillSwitchEngaged({ privateDir, env })) {
        controller.abort();
        throw liveAcquisitionError("LIVE_ADAPTER_DISABLED", "تم تفعيل مفتاح الإيقاف أثناء النقل.");
      }
      if (Date.now() - started >= timeoutMs) {
        controller.abort();
        throw liveAcquisitionError("LIVE_DOWNLOAD_TIMEOUT", "تجاوزت محاولة الملف 60 ثانية.");
      }
      const currentSize = await stat(quarantinePath).then((value) => value.size).catch((error) => error?.code === "ENOENT" ? 0 : Promise.reject(error));
      if (currentSize > maxBytes) {
        controller.abort();
        throw liveAcquisitionError("LIVE_FILE_TOO_LARGE", "تجاوز الملف 100MB أثناء النقل.");
      }
      await sleep(100);
    }
    return null;
  })();
  try {
    return await Promise.race([driver.acquire({ ...args, signal: controller.signal, maxBytes, timeoutMs }), guard]);
  } finally {
    finished = true;
    controller.abort();
  }
}

export function createLiveDownloadAdapter({ repository, projectRoot, privateDir, env = process.env, driver = null, maxBytes = liveMaxFileBytes, timeoutMs = liveTimeoutMs, preflightTimeoutMs = livePreflightTimeoutMs } = {}) {
  if (!repository) throw new Error("createLiveDownloadAdapter يحتاج repository.");
  if (!projectRoot || !privateDir) throw new Error("createLiveDownloadAdapter يحتاج projectRoot وprivateDir.");
  return {
    kind: "live-guarded-single-free-unconfigured",
    async execute(job) {
      const config = readLiveAcquisitionConfig(env);
      if (await isLiveKillSwitchEngaged({ privateDir, env }) || !config.enabled || !config.allowlistComplete) {
        throw liveAcquisitionError("LIVE_ADAPTER_DISABLED", "التنفيذ الحي معطل أو قائمة السماح غير مكتملة.");
      }
      assertManifestMatchesLiveAllowlist({ manifest: job?.manifest, config });
      const manifest = job.manifest;
      const displayName = manifest.files[0].displayName;
      const tender = repository.getTender(manifest.tenderReference);
      assertLivePreconditions({ tender, displayName });
      const trustedTenderUrl = assertTrustedTenderUrl(tender.etimadUrl);
      const approval = repository.getDownloadApproval(job.approvalId);
      assertApprovalReady({ approval, manifest });

      // لا يوجد driver إنتاجي في P3-B1A؛ لذلك يفشل قبل استهلاك الموافقة حتى تنتهي معاينة P3-B1B.
      if (!driver || typeof driver.preflight !== "function" || typeof driver.acquire !== "function") {
        throw liveAcquisitionError("LIVE_DRIVER_NOT_CONFIGURED", "لم يُعتمد driver حي بعد؛ يلزم فحص P3-B1B أولًا.");
      }
      const target = await runBoundedPreflight(driver, { tender, trustedTenderUrl, displayName, manifestHash: config.manifestSha256 }, preflightTimeoutMs);
      if (!target?.ready || target.tenderReference !== tender.reference || target.displayName !== displayName || !target.targetId) {
        throw liveAcquisitionError("LIVE_TARGET_MISMATCH", "لم يثبت الفحص أن الصفحة والملف يطابقان الموافقة.");
      }
      assertSafeDownloadTrigger(target.elementInfo);
      if (await isLiveKillSwitchEngaged({ privateDir, env })) throw liveAcquisitionError("LIVE_ADAPTER_DISABLED", "مفتاح الإيقاف مفعّل.");
      assertApprovalReady({ approval: repository.getDownloadApproval(job.approvalId), manifest });

      const consumed = repository.consumeDownloadApproval(job.approvalId, { manifest });
      const jobDir = quarantineJobDirectory(privateDir, job.id);
      const quarantinePath = quarantinePathFor(privateDir, job.id, displayName);
      const finalPath = resolveAttachmentStoragePath(projectRoot, tender.reference, displayName);
      await mkdir(jobDir, { recursive: true });
      try {
        const transfer = await runBoundedAcquisition({
          driver,
          args: { tender, trustedTenderUrl, displayName, target, quarantinePath },
          quarantinePath, privateDir, env, maxBytes, timeoutMs,
        });
        const entries = await readdir(jobDir);
        if (entries.length !== 1 || path.join(jobDir, entries[0]) !== quarantinePath) {
          throw liveAcquisitionError("LIVE_MULTIPLE_FILES", "لم تنتج المحاولة ملفًا واحدًا مطابقًا فقط.");
        }
        const inspection = await inspectQuarantinedFile({ quarantinePath, displayName, maxBytes, contentType: transfer?.contentType });
        await mkdir(path.dirname(finalPath), { recursive: true });
        try {
          // hard link ينشر ملفًا مكتملًا دون استبدال ملف قائم، ثم نحذف نسخة الحجر.
          await link(quarantinePath, finalPath);
        } catch (error) {
          if (error?.code === "EEXIST") throw liveAcquisitionError("LIVE_STORAGE_CONFLICT", "يوجد ملف محفوظ سابقًا لنفس المرفق؛ لن يُستبدل.");
          throw error;
        }
        try {
          repository.markAttachmentDownloaded(tender.reference, displayName, {
            localPath: finalPath, sha256: inspection.sha256, mimeType: inspection.mimeType, size: inspection.size,
          });
        } catch (error) {
          await rm(finalPath, { force: true }).catch(() => {});
          throw error;
        }
        await cleanupJobQuarantine(jobDir);
        return { status: "complete", files: [finalPath], sha256: inspection.sha256, size: inspection.size, approvalId: consumed.id };
      } catch (error) {
        await cleanupJobQuarantine(jobDir);
        throw error;
      }
    },
  };
}
