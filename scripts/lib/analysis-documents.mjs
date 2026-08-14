// طبقة مستندات التحليل المحلي — P4-A0.
// تستخرج PDF/XLSX/DOCX من ملفات محلية مسموحة فقط (fixtures)، بتمثيل موحد
// يحفظ النص ومصدره (صفحة/ورقة/قسم) والجداول وتحذيرات الاستخراج.
// لا تنفذ أي macros أو روابط أو محتوى مضمن؛ القراءة نصية حتمية فقط.
import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import path from "node:path";

export const supportedDocumentTypes = ["pdf", "xlsx", "docx"];
export const defaultMaxFileBytes = 30 * 1024 * 1024;
// حد أقصى لتدفق PDF المضغوط بعد فكه — حماية من تضخم التدفقات.
export const defaultMaxPdfStreamBytes = 8 * 1024 * 1024;

const mimeByType = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function documentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------- أمان المسارات: لا traversal ولا مسارات مطلقة ولا خروج عن الجذر ----------
export function resolveAnalysisPath(fixtureRoot, fileName) {
  const root = path.resolve(fixtureRoot);
  const name = String(fileName || "");
  if (!name || path.isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw documentError("DOCUMENT_PATH_NOT_ALLOWED", "مسار الملف غير مسموح؛ يُقبل اسم ملف داخلي فقط.");
  }
  const resolved = path.resolve(root, name);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw documentError("DOCUMENT_PATH_NOT_ALLOWED", "محاولة خروج عن مجلد التحليل المسموح مرفوضة.");
  }
  return resolved;
}

// ---------- فحص الامتداد والتوقيع والحجم ----------
export function inspectDocumentBuffer({ fileName, buffer, maxBytes = defaultMaxFileBytes }) {
  const extension = path.extname(String(fileName || "")).slice(1).toLowerCase();
  if (!supportedDocumentTypes.includes(extension)) {
    throw documentError("DOCUMENT_TYPE_NOT_SUPPORTED", `نوع المستند غير مدعوم: ${extension || "بلا امتداد"}. المدعوم: PDF وXLSX وDOCX.`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw documentError("DOCUMENT_EMPTY", "الملف فارغ أو غير قابل للقراءة.");
  }
  if (buffer.length > maxBytes) {
    throw documentError("DOCUMENT_TOO_LARGE", `حجم الملف يتجاوز الحد المسموح (${Math.round(maxBytes / (1024 * 1024))} م.ب).`);
  }
  const isPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (extension === "pdf" && !isPdf) {
    throw documentError("DOCUMENT_MIME_MISMATCH", "محتوى الملف لا يطابق امتداد PDF.");
  }
  if ((extension === "xlsx" || extension === "docx") && !isZip) {
    throw documentError("DOCUMENT_MIME_MISMATCH", `محتوى الملف لا يطابق امتداد ${extension.toUpperCase()}.`);
  }
  return { documentType: extension, mimeType: mimeByType[extension], sizeBytes: buffer.length };
}

// ---------- قارئ ZIP محصن: دليل مركزي + Stored/Deflate فقط، بحدود صارمة ----------
// يتحقق من أن كل الإزاحات والأحجام داخل المخزن الفعلي، ويرفض القنابل المضغوطة
// (عضو ضخم، نسبة تضخم مفرطة، إجمالي مفرط، أو عدد أعضاء مفرط) قبل أي فك ضغط.
export const defaultZipLimits = {
  maxEntries: 64,
  maxMemberBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRatio: 100,
};

export function readZipEntries(buffer, limits = {}) {
  const { maxEntries, maxMemberBytes, maxTotalBytes, maxRatio } = { ...defaultZipLimits, ...limits };
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 22 - 65_535; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocdOffset = index; break; }
  }
  if (eocdOffset < 0) throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: الدليل المركزي مفقود.");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  if (entryCount > maxEntries) {
    throw documentError("DOCUMENT_CORRUPT", `بنية ZIP مرفوضة: عدد الأعضاء (${entryCount}) يتجاوز الحد (${maxEntries}).`);
  }
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  if (cursor + centralSize > eocdOffset) {
    throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: الدليل المركزي خارج حدود الملف.");
  }
  const entries = new Map();
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: ترويسة مركزية تالفة.");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength > buffer.length) throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: اسم عضو مقطوع.");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (entries.has(name)) throw documentError("DOCUMENT_CORRUPT", `بنية ZIP غير صالحة: اسم العضو مكرر: ${name}.`);
    if (uncompressedSize > maxMemberBytes) {
      throw documentError("DOCUMENT_TOO_LARGE", `العضو ${name} يتجاوز حد الحجم المسموح بعد فك الضغط.`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > maxRatio) {
      throw documentError("DOCUMENT_TOO_LARGE", `العضو ${name} يتجاوز نسبة التضخم المسموحة (قنبلة ضغط مشتبه بها).`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: ترويسة محلية تالفة.");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      throw documentError("DOCUMENT_CORRUPT", "بنية ZIP غير صالحة: بيانات العضو خارج حدود الملف.");
    }
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) {
      if (uncompressedSize !== compressedSize) throw documentError("DOCUMENT_CORRUPT", `بنية ZIP غير صالحة: حجم العضو المخزن ${name} غير متسق.`);
      content = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: maxMemberBytes });
      } catch {
        throw documentError("DOCUMENT_CORRUPT", `تعذر فك ضغط العضو: ${name}`);
      }
      // الحجم المعلن كاذب أو متلاعب به: الحجم الفعلي بعد الفك يجب أن يطابق المعلن تمامًا.
      if (content.length !== uncompressedSize) {
        throw documentError("DOCUMENT_CORRUPT", `بنية ZIP غير صالحة: الحجم الفعلي للعضو ${name} لا يطابق الحجم المعلن.`);
      }
      if (content.length > maxMemberBytes) {
        throw documentError("DOCUMENT_TOO_LARGE", `العضو ${name} يتجاوز حد الحجم المسموح بعد فك الضغط.`);
      }
    } else {
      throw documentError("DOCUMENT_TYPE_NOT_SUPPORTED", `طريقة ضغط ZIP غير مدعومة (${method}) في ${name}.`);
    }
    // الحد الإجمالي يُحسب بالحجم الفعلي بعد الفك، لا بالحجم المعلن في الترويسة.
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) {
      throw documentError("DOCUMENT_TOO_LARGE", "الحجم الإجمالي بعد فك الضغط يتجاوز الحد المسموح.");
    }
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------- أدوات XML نصية آمنة (بلا تنفيذ وبلا كيانات خارجية) ----------
function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function xmlTexts(fragment, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...fragment.matchAll(pattern)].map((match) => decodeXmlEntities(match[1].replace(/<[^>]+>/g, "")).trim()).filter(Boolean);
}

// ---------- مستخرج PDF: صفحات مرقمة وأسطر نصية ----------
function utf16beToString(bytes) {
  const codes = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) codes.push(bytes.readUInt16BE(index));
  return String.fromCharCode(...codes);
}

function decodePdfString(token) {
  if (token.startsWith("<")) {
    const hex = token.slice(1, -1).replace(/\s+/g, "");
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16beToString(bytes.subarray(2));
    return bytes.toString("latin1");
  }
  return token.slice(1, -1).replace(/\\([()\\])/g, "$1").replace(/\\n/g, "\n");
}

function extractPdfTextFromStream(content) {
  const texts = [];
  const pattern = /(<[0-9A-Fa-f\s]+>|\((?:[^()\\]|\\.)*\))\s*Tj|\[((?:[\s\S]*?))\]\s*TJ/g;
  for (const match of content.matchAll(pattern)) {
    if (match[1]) texts.push(decodePdfString(match[1]));
    else if (match[2]) {
      const parts = [...match[2].matchAll(/(<[0-9A-Fa-f\s]+>|\((?:[^()\\]|\\.)*\))/g)].map((part) => decodePdfString(part[1]));
      texts.push(parts.join(""));
    }
  }
  return texts.filter((line) => line.trim());
}

function extractPdfDocument(buffer, maxStreamBytes = defaultMaxPdfStreamBytes) {
  const warnings = [];
  const objects = new Map();
  for (const match of buffer.toString("latin1").matchAll(/(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const pagesObject = [...objects.values()].find((body) => /\/Type\s*\/Pages\b/.test(body));
  if (!pagesObject) throw documentError("DOCUMENT_CORRUPT", "ملف PDF بلا شجرة صفحات.");
  const kidOrder = [...pagesObject.matchAll(/(\d+)\s+0\s+R/g)].map((match) => Number(match[1]));
  const blocks = [];
  kidOrder.forEach((pageId, pageIndex) => {
    const page = objects.get(pageId);
    if (!page || !/\/Type\s*\/Page\b/.test(page)) return;
    const contentsRef = page.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (!contentsRef) { warnings.push(`الصفحة ${pageIndex + 1} بلا محتوى`); return; }
    const streamObject = objects.get(Number(contentsRef[1])) || "";
    const streamMatch = streamObject.match(/stream\r?\n([\s\S]*?)\r?\n?endstream/);
    if (!streamMatch) { warnings.push(`الصفحة ${pageIndex + 1} بلا تدفق نصي`); return; }
    let streamContent = Buffer.from(streamMatch[1], "latin1");
    if (/\/FlateDecode/.test(streamObject)) {
      // تدفق PDF القياسي zlib-wrapped (inflateSync)؛ Raw Deflate fallback للملفات غير القياسية.
      // maxOutputLength يمنع تضخم التدفق المضغوط فوق الحد في الحالتين.
      try {
        streamContent = inflateSync(streamContent, { maxOutputLength: maxStreamBytes });
      } catch {
        try {
          streamContent = inflateRawSync(streamContent, { maxOutputLength: maxStreamBytes });
        } catch {
          warnings.push(`تعذر فك ضغط الصفحة ${pageIndex + 1} أو تجاوز تدفقها الحد المسموح`);
          return;
        }
      }
    }
    const lines = extractPdfTextFromStream(streamContent.toString("latin1"));
    if (!lines.length) warnings.push(`الصفحة ${pageIndex + 1} بلا نص قابل للاستخراج`);
    lines.forEach((text, lineIndex) => {
      blocks.push({
        blockId: `p${pageIndex + 1}-l${lineIndex + 1}`,
        kind: "page-text",
        text,
        source: { pageNumber: pageIndex + 1 },
      });
    });
  });
  if (!blocks.length) throw documentError("DOCUMENT_NO_TEXT", "لم يُستخرج أي نص من ملف PDF.");
  return { blocks, tables: [], warnings };
}

// ---------- مستخرج XLSX: أوراق مسماة وخلايا ذات عناوين ----------
function extractXlsxDocument(buffer) {
  const warnings = [];
  const entries = readZipEntries(buffer);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8");
  if (!workbookXml) throw documentError("DOCUMENT_CORRUPT", "ملف XLSX بلا workbook.xml.");
  const sharedStrings = entries.has("xl/sharedStrings.xml")
    ? [...entries.get("xl/sharedStrings.xml").toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => xmlTexts(match[1], "t").join(""))
    : [];
  if (!entries.has("xl/sharedStrings.xml")) warnings.push("ملف XLSX بلا سلاسل مشتركة");
  const rels = new Map();
  const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  for (const match of relsXml.matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels.set(match[1], match[2]);
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    sheets.push({ name: decodeXmlEntities(match[1]), target: rels.get(match[2]) });
  }
  const blocks = [];
  const tables = [];
  sheets.forEach((sheet, sheetIndex) => {
    const file = sheet.target ? `xl/${sheet.target.replace(/^\/?(xl\/)?/, "")}` : `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const sheetXml = entries.get(file)?.toString("utf8");
    if (!sheetXml) { warnings.push(`الورقة ${sheet.name} بلا محتوى`); return; }
    const rows = [];
    for (const rowMatch of sheetXml.matchAll(/<row\s[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowNumber = Number(rowMatch[1]);
      const cells = [];
      for (const cellMatch of rowMatch[2].matchAll(/<c\s[^>]*r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const [, address, attributes, body] = cellMatch;
        const rawValue = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? "";
        const value = /t="s"/.test(attributes) ? (sharedStrings[Number(rawValue)] ?? "") : decodeXmlEntities(rawValue);
        cells.push({ address, value });
      }
      if (cells.length) rows.push({ rowNumber, cells });
    }
    if (!rows.length) warnings.push(`الورقة ${sheet.name} فارغة`);
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const tableRange = rows.length
      ? `${firstRow.cells[0].address}:${lastRow.cells[lastRow.cells.length - 1].address}`
      : "";
    tables.push({
      tableId: `sheet-${sheetIndex + 1}`,
      source: { sheetName: sheet.name, cellRange: tableRange },
      rows: rows.map((row) => row.cells.map((cell) => cell.value)),
    });
    for (const row of rows) {
      const range = `${row.cells[0].address}:${row.cells[row.cells.length - 1].address}`;
      blocks.push({
        blockId: `s${sheetIndex + 1}-r${row.rowNumber}`,
        kind: "table-row",
        text: row.cells.map((cell) => cell.value).join(" | "),
        source: { sheetName: sheet.name, cellRange: range },
        tableId: `sheet-${sheetIndex + 1}`,
      });
    }
  });
  if (!blocks.length) throw documentError("DOCUMENT_NO_TEXT", "لم يُستخرج أي محتوى من ملف XLSX.");
  return { blocks, tables, warnings };
}

// ---------- مستخرج DOCX: عناوين كأقسام وفقرات وجداول ----------
function extractDocxDocument(buffer) {
  const warnings = [];
  const entries = readZipEntries(buffer);
  const documentXml = entries.get("word/document.xml")?.toString("utf8");
  if (!documentXml) throw documentError("DOCUMENT_CORRUPT", "ملف DOCX بلا word/document.xml.");
  const blocks = [];
  const tables = [];
  let section = "المستند";
  let paragraphIndex = 0;
  let tableIndex = 0;
  const bodyMatch = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : documentXml;
  const elementPattern = /<w:p\b[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g;
  for (const match of body.matchAll(elementPattern)) {
    const element = match[0];
    if (element.startsWith("<w:tbl")) {
      tableIndex += 1;
      const rows = [...element.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map((row) =>
        [...row[1].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) => xmlTexts(cell[0], "w:t").join(" ")),
      );
      tables.push({ tableId: `tbl-${tableIndex}`, source: { section }, rows });
      rows.forEach((row, rowIndex) => {
        blocks.push({
          blockId: `t${tableIndex}-r${rowIndex + 1}`,
          kind: "table-row",
          text: row.join(" | "),
          source: { section },
          tableId: `tbl-${tableIndex}`,
        });
      });
      continue;
    }
    const text = xmlTexts(element, "w:t").join(" ").trim();
    if (!text) continue;
    const isHeading = /<w:pStyle\s+w:val="Heading/i.test(element);
    if (isHeading) section = text;
    paragraphIndex += 1;
    blocks.push({
      blockId: `p-${paragraphIndex}`,
      kind: isHeading ? "heading" : "paragraph",
      text,
      source: { section },
    });
  }
  if (!blocks.length) throw documentError("DOCUMENT_NO_TEXT", "لم يُستخرج أي نص من ملف DOCX.");
  return { blocks, tables, warnings };
}

// ---------- نقطة الدخول الموحدة ----------
export function extractAnalysisDocument({ documentId, fileName, buffer, maxBytes, maxStreamBytes }) {
  const inspected = inspectDocumentBuffer({ fileName, buffer, maxBytes });
  let extracted;
  if (inspected.documentType === "pdf") extracted = extractPdfDocument(buffer, maxStreamBytes ?? defaultMaxPdfStreamBytes);
  else if (inspected.documentType === "xlsx") extracted = extractXlsxDocument(buffer);
  else extracted = extractDocxDocument(buffer);
  return {
    documentId,
    documentType: inspected.documentType,
    mimeType: inspected.mimeType,
    sizeBytes: inspected.sizeBytes,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    fileName: path.basename(String(fileName)),
    blocks: extracted.blocks,
    tables: extracted.tables,
    warnings: extracted.warnings,
  };
}
