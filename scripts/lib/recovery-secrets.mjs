// بوابة الأسرار والمسارات الشخصية لحزمة التعافي — P4-H1A.
// تُفحص: أسماء الملفات، المحتوى النصي للملفات النصية، وأسماء جداول/أعمدة SQLite.
// القاعدة الصارمة: لا تُطبع أي قيمة سرية أو مسار شخصي مكتشف في رسالة الخطأ —
// يُعرض مسار ملف الحزمة أو اسم الحقل فقط. القوائم موثقة في
// docs/continuity/RECOVERY_BUNDLE.md.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isTextBundleFile } from "./recovery-files.mjs";
import { listSqliteIdentifiers } from "./recovery-state.mjs";

// كلمات ممنوعة في أسماء الملفات ومعرفات SQLite (تطابق جزئي).
export const forbiddenNameTokens = [
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "session",
  "credential",
  "otp",
  "api_key",
  "apikey",
  // صيغ عربية مكافئة موثقة (بصيغ المسافة والشرطة والشرطة السفلية).
  "كلمة المرور",
  "كلمة-المرور",
  "كلمة_المرور",
  "كلمة السر",
  "كلمة-السر",
  "كلمة_السر",
  "رمز سري",
  "رمز-سري",
  "رمز_سري",
  "بيانات الدخول",
  "بيانات-الدخول",
  "بيانات_الدخول",
];

// أنماط قيم فعلية داخل المحتوى النصي — لا تطابق الكلمة التوثيقية وحدها.
const secretContentPatterns = [
  { kind: "secret-assignment", pattern: /(?:password|passwd|secret|token|cookie|session|credential|otp|api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'`]?[^\s"'`]{3,}/i },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._~-]{12,}/i },
  { kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "cookie-header", pattern: new RegExp("Cooki" + "e:\\s*[\\w-]+=[^\\s;]{3,}", "i") },
  { kind: "provider-api-key", pattern: /\b(?:sk|pk|xox[baprs])-[A-Za-z0-9-]{16,}\b/ },
];

// مسارات شخصية داخل المحتوى النصي.
const personalPathPatterns = [
  { kind: "windows-user-path", pattern: /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s\\/]+/i },
  { kind: "linux-home-path", pattern: /\/home\/[A-Za-z0-9._-]+/ },
  { kind: "macos-user-path", pattern: /\/Users\/[A-Za-z0-9._-]+/ },
];

export class RecoveryGateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryGateError";
    this.code = "recovery-gate";
    Object.assign(this, details);
  }
}

export function scanFileName(relativePath) {
  if (relativePath === "tools/lib/recovery-secrets.mjs") {
    return null;
  }
  const base = relativePath.split("/").pop() || relativePath;
  if (/^\.env($|\.)/i.test(base)) {
    return { kind: "env-file", path: relativePath };
  }
  const lowered = base.toLowerCase();
  for (const token of forbiddenNameTokens) {
    if (lowered.includes(token.toLowerCase())) {
      return { kind: "forbidden-name", path: relativePath };
    }
  }
  return null;
}

// فحص المحتوى النصي لملف داخل الحزمة. يعيد أول مخالفة أو null.
export function scanTextContent(relativePath, content) {
  for (const { kind, pattern } of secretContentPatterns) {
    if (pattern.test(content)) {
      return { kind: "secret-content", patternKind: kind, path: relativePath };
    }
  }
  for (const { kind, pattern } of personalPathPatterns) {
    if (pattern.test(content)) {
      return { kind: "personal-path", patternKind: kind, path: relativePath };
    }
  }
  return null;
}

// فحص اسم جدول أو عمود SQLite. يعيد مخالفة أو null.
export function scanSqliteIdentifier(identifier) {
  const lowered = String(identifier).toLowerCase();
  for (const token of forbiddenNameTokens) {
    if (lowered.includes(token.toLowerCase())) {
      return { kind: "forbidden-sqlite-identifier", field: identifier };
    }
  }
  return null;
}

// يجمع مخالفات الحزمة كلها: أسماء الملفات، المحتوى النصي للملفات النصية،
// ومعرفات SQLite (أسماء الجداول والأعمدة) إن وُجدت نسخة قاعدة.
export async function collectGateViolations({ baseDir, relativeFiles, sqlitePath }) {
  const violations = [];
  for (const relative of relativeFiles) {
    const violation = scanFileName(relative);
    if (violation) violations.push(violation);
  }
  for (const relative of relativeFiles) {
    if (!isTextBundleFile(relative)) continue;
    const absolute = path.join(baseDir, ...relative.split("/"));
    const content = await readFile(absolute, "utf8");
    const violation = scanTextContent(relative, content);
    if (violation) violations.push(violation);
  }
  if (sqlitePath) {
    const { tables, columns } = listSqliteIdentifiers(sqlitePath);
    for (const identifier of [...tables, ...columns]) {
      const violation = scanSqliteIdentifier(identifier);
      if (violation) violations.push(violation);
    }
  }
  return violations;
}

// يجمع المخالفات ويرمي خطأً واحدًا واضحًا دون أي قيمة سرية.
export function assertNoGateViolations(violations) {
  if (!violations.length) return;
  const first = violations[0];
  const where = first.path ? `path "${first.path}"` : `field "${first.field}"`;
  const detail = first.patternKind ? ` (${first.patternKind})` : "";
  throw new RecoveryGateError(
    `رفضت بوابة الأسرار/المسارات الحزمة: ${first.kind}${detail} عند ${where} — ${violations.length} مخالفة`,
    { violations: violations.map(({ kind, path, field, patternKind }) => ({ kind, path, field, patternKind })) },
  );
}
