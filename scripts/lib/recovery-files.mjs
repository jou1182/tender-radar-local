// أدوات ملفات مشتركة لحزمة التعافي — P4-H1A.
// بصمات SHA‑256 بقراءة متدفقة، سرد تكراري بمسارات نسبية posix، وكتابة ذرية
// (ملف مؤقت ثم rename) قدر الإمكان.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// يسرد كل الملفات تحت dir بمسارات نسبية posix مرتبة (دلائل فرعية مشمولة).
export async function listFilesRecursively(dir) {
  const results = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        results.push(relative);
      }
    }
  }
  await walk(dir, "");
  return results.sort();
}

// كتابة ذرية: ملف مؤقت في نفس المجلد ثم rename.
export async function writeFileAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

// نسخ ذري بنفس الأسلوب.
export async function copyFileAtomic(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await copyFile(source, temporary);
  await rename(temporary, target);
}

// هل child داخل parent (أو يساويه)؟
export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const textExtensions = new Set([".md", ".json", ".txt", ".mjs"]);

// ملفات الحزمة النصية التي تخضع لفحص المحتوى (repo.bundle وdatabase.sqlite
// ثنائية ولا تُفحص كنص — القرار موثق في docs/continuity/RECOVERY_BUNDLE.md).
export function isTextBundleFile(relativePath) {
  if (relativePath === "SHA256SUMS" || relativePath === "BUNDLE_FAILED.txt") return true;
  return textExtensions.has(path.posix.extname(relativePath).toLowerCase());
}

export { existsSync };
