// مصنع fixtures تحليل المستندات — P4-A0.
// ينتج ملفات PDF/XLSX/DOCX صغيرة مصطنعة بالكامل وغير حساسة، بنص عربي UTF-8،
// لاستخدامها في الاختبارات والـfixtures الملتزم بها. لا توجد هنا أي بيانات حقيقية.
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------- كاتب ZIP أدنى (تخزين أو Deflate) ----------
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data, compress = true } of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const compressed = compress ? deflateRawSync(content) : content;
    const method = compress ? 8 : 0;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

// ---------- باني PDF أدنى: صفحات مرقمة ونص UTF-16BE داخل عوامل Tj ----------
function utf16beBuffer(text) {
  const buffer = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) buffer.writeUInt16BE(text.charCodeAt(index), index * 2);
  return buffer;
}

function pdfHex(text) {
  return `<${Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBuffer(text)]).toString("hex").toUpperCase()}>`;
}

export function buildPdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  pages.forEach((lines, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const textOps = lines.map((line, lineIndex) => `BT /F1 12 Tf 50 ${800 - lineIndex * 20} Td ${pdfHex(line)} Tj ET`).join("\n");
    objects.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`]);
    objects.push([contentId, `<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`]);
  });
  objects.push([3 + pages.length * 2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);

  let output = "%PDF-1.4\n";
  const offsets = [];
  for (const [id, body] of objects) {
    offsets.push([id, Buffer.byteLength(output)]);
    output += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(output);
  const count = objects.length + 1;
  output += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const [, byteOffset] of offsets) output += `${String(byteOffset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

// ---------- باني XLSX أدنى: أوراق مسماة وخلايا ذات عناوين ----------
function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export function buildXlsx(sheets) {
  const sharedStrings = [];
  const sharedIndex = new Map();
  const share = (value) => {
    if (!sharedIndex.has(value)) {
      sharedIndex.set(value, sharedStrings.length);
      sharedStrings.push(value);
    }
    return sharedIndex.get(value);
  };
  const sheetXml = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows.map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => {
        const address = `${columnName(columnIndex)}${rowIndex + 1}`;
        if (typeof cell === "number") return `<c r="${address}"><v>${cell}</v></c>`;
        return `<c r="${address}" t="s"><v>${share(String(cell))}</v></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    return { name: sheet.name, file: `xl/worksheets/sheet${sheetIndex + 1}.xml`, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` };
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetXml.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`;
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((value) => `<si><t xml:space="preserve">${value}</t></si>`).join("")}</sst>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetXml.map((sheet) => `<Override PartName="/${sheet.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
    { name: "xl/sharedStrings.xml", data: shared },
    ...sheetXml.map((sheet) => ({ name: sheet.file, data: sheet.xml })),
  ]);
}

// ---------- باني DOCX أدنى: عناوين (أقسام) وفقرات وجداول ----------
export function buildDocx(parts) {
  const body = parts.map((part) => {
    if (part.heading) {
      return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${part.heading}</w:t></w:r></w:p>`;
    }
    if (part.table) {
      const rows = part.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("");
      return `<w:tbl>${rows}</w:tbl>`;
    }
    return `<w:p><w:r><w:t xml:space="preserve">${part.paragraph}</w:t></w:r></w:p>`;
  }).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "word/document.xml", data: document },
  ]);
}

// ---------- محتوى fixtures الافتراضي: نصوص عربية مصطنعة غير حساسة ----------
export const fixtureContent = {
  bookletPdf: {
    pages: [
      [
        "كراسة شروط مصطنعة للاختبار — منافسة تدريبية رقم 260000009999",
        "الجهة: جهة اختبار افتراضية",
        "قيمة وثائق المنافسة: 0 ريال",
        "آخر موعد لتقديم العروض: 2026-10-01 الساعة 09:59",
        "الضمان الابتدائي: 5000 ريال سعودي",
      ],
      [
        "شروط الأهلية: سجل تجاري ساري وشهادة تصنيف",
        "الخبرة المطلوبة: ثلاثة مشاريع مشابهة خلال خمس سنوات",
        "الضمان النهائي: 5% من قيمة العقد",
        "غرامة التأخير: 0.1% يوميًا بحد أقصى 10%",
      ],
      [
        "بند غير واضح: آلية احتساب الأعمال الإضافية",
        "سؤال للجهة: هل تشمل قيمة العقد ضريبة القيمة المضافة؟",
        "نطاق العمل: تنفيذ وصيانة مبنى تدريبي افتراضي",
      ],
    ],
  },
  boqXlsx: {
    sheets: [
      {
        name: "جدول الكميات",
        rows: [
          ["البند", "الوصف", "الوحدة", "الكمية"],
          ["1", "أعمال حفر تأسيسية", "م3", 1200],
          ["2", "خرسانة مسلحة", "م3", 800],
          ["3", "أعمال تشطيب", "م2", 3500],
        ],
      },
      {
        name: "ملاحظات",
        rows: [
          ["ملاحظة", "الكميات تقديرية لأغراض الاختبار فقط"],
        ],
      },
    ],
  },
  conditionsDocx: {
    parts: [
      { heading: "الشروط العامة" },
      { paragraph: "يلتزم المتعاقد بجميع الأنظمة واللوائح ذات العلاقة." },
      { paragraph: "مدة العقد: اثنا عشر شهرًا من تاريخ التسليم الابتدائي." },
      { heading: "الالتزامات والغرامات" },
      { paragraph: "تطبق غرامة تأخير بواقع 0.1% عن كل يوم تأخير." },
      { paragraph: "يقدم المتعاقد ضمانًا نهائيًا بنسبة 5% من قيمة العقد." },
      { table: [["الشرط", "القيمة"], ["الضمان الابتدائي", "5000 ريال"], ["الضمان النهائي", "5%"]] },
    ],
  },
};

export function buildFixtureBuffers() {
  return {
    "booklet-pdf": buildPdf(fixtureContent.bookletPdf.pages),
    "boq-xlsx": buildXlsx(fixtureContent.boqXlsx.sheets),
    "conditions-docx": buildDocx(fixtureContent.conditionsDocx.parts),
  };
}

export function fixtureChecksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
