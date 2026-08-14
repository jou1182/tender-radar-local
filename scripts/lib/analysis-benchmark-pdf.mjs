// باني PDF عربي خاص بمنصة المقارنة — P4-M0AR.
// يبني PDF معياريًا حتميًا بطبقتين:
//  1) طبقة مرئية: حروف عربية مشكّلة (أشكال عرض أولية/وسطية/نهائية) ومرتبة RTL
//     تُرسم كمسارات vector من خط DejaVu المقلَّص المحلي (لا Helvetica إطلاقًا).
//  2) طبقة نص Unicode كاملة غير مرئية (rendering mode 3) بخط Type0 مضمّن
//     (FontFile2 = الـsubset المحلي نفسه) مع ToUnicode — النص المنطقي كاملًا
//     قابل للبحث والنسخ والاستخراج دون OCR، ويقرأه مستخرج المشروع (UTF-16BE)
//     وأي مستخرج مستقل عبر ToUnicode.
// لا شبكة ولا خطوط نظام: الخط أصل ملتزم به داخل benchmark/assets/fonts.
import { deflateSync, inflateSync } from "node:zlib";

// حد فك ضغط تدفق الصفحة في المستخرج المستقل — يمنع تضخمًا خبيثًا.
const maxExtractedStreamBytes = 8 * 1024 * 1024;

// ---------- تنسيق أعداد حتمي للإحداثيات ----------
function fmt(value) {
  const rounded = Math.round(value * 100) / 100;
  const text = String(rounded);
  return text === "-0" ? "0" : text;
}

// ---------- قارئ TTF أدنى: head/maxp/hhea/hmtx/loca/glyf/cmap(صيغة 4) ----------
export function parseTtf(buffer) {
  const u16 = (offset) => buffer.readUInt16BE(offset);
  const i16 = (offset) => buffer.readInt16BE(offset);
  const u32 = (offset) => buffer.readUInt32BE(offset);
  const numTables = u16(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    tables.set(buffer.toString("latin1", record, record + 4), { offset: u32(record + 8), length: u32(record + 12) });
  }
  for (const tag of ["head", "maxp", "hhea", "hmtx", "loca", "glyf", "cmap"]) {
    if (!tables.has(tag)) throw new Error(`TTF: الجدول ${tag} مفقود.`);
  }
  const head = tables.get("head").offset;
  const unitsPerEm = u16(head + 18);
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
  const indexToLocFormat = i16(head + 50);
  const maxp = tables.get("maxp").offset;
  const numGlyphs = u16(maxp + 4);
  const hhea = tables.get("hhea").offset;
  const ascent = i16(hhea + 4);
  const descent = i16(hhea + 6);
  const numberOfHMetrics = u16(hhea + 34);
  const hmtx = tables.get("hmtx").offset;
  const advances = [];
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    advances.push(glyph < numberOfHMetrics ? u16(hmtx + glyph * 4) : advances[numberOfHMetrics - 1]);
  }
  const locaOffset = tables.get("loca").offset;
  const loca = [];
  for (let glyph = 0; glyph <= numGlyphs; glyph += 1) {
    loca.push(indexToLocFormat === 0 ? u16(locaOffset + glyph * 2) * 2 : u32(locaOffset + glyph * 4));
  }
  const glyf = tables.get("glyf").offset;

  // cmap صيغة 4 (الـsubset المحلي يضمنها لأن كل الرموز < U+FFFF).
  const cmapOffset = tables.get("cmap").offset;
  const subCount = u16(cmapOffset + 2);
  let format4 = -1;
  for (let index = 0; index < subCount; index += 1) {
    const sub = cmapOffset + u32(cmapOffset + 4 + index * 8 + 4);
    if (u16(sub) === 4) { format4 = sub; break; }
  }
  if (format4 < 0) throw new Error("TTF: لا توجد cmap بصيغة 4.");
  const segCount = u16(format4 + 6) / 2;
  const endBase = format4 + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  const cmap = new Map();
  for (let segment = 0; segment < segCount; segment += 1) {
    const startCode = u16(startBase + segment * 2);
    const endCode = u16(endBase + segment * 2);
    if (startCode === 0xffff) continue;
    const delta = i16(deltaBase + segment * 2);
    const rangeOffsetPos = rangeBase + segment * 2;
    const rangeOffset = u16(rangeOffsetPos);
    for (let code = startCode; code <= endCode; code += 1) {
      let gid = 0;
      if (rangeOffset === 0) gid = (code + delta) & 0xffff;
      else {
        const glyphPos = rangeOffsetPos + rangeOffset + (code - startCode) * 2;
        const raw = u16(glyphPos);
        gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (gid) cmap.set(code, gid);
    }
  }

  function glyphContours(glyphId, depth = 0) {
    if (depth > 4) throw new Error("TTF: glyph مركب متعمق أكثر من المسموح.");
    if (glyphId >= numGlyphs) throw new Error(`TTF: glyphId ${glyphId} خارج النطاق.`);
    const start = glyf + loca[glyphId];
    if (loca[glyphId + 1] === loca[glyphId]) return [];
    const numberOfContours = i16(start);
    if (numberOfContours >= 0) {
      let cursor = start + 10;
      const endPts = [];
      for (let contour = 0; contour < numberOfContours; contour += 1) { endPts.push(u16(cursor)); cursor += 2; }
      const pointCount = endPts[endPts.length - 1] + 1;
      const instructionLength = u16(cursor);
      cursor += 2 + instructionLength;
      const flags = [];
      while (flags.length < pointCount) {
        const value = buffer[cursor]; cursor += 1;
        flags.push(value);
        if (value & 0x08) {
          const repeat = buffer[cursor]; cursor += 1;
          for (let index = 0; index < repeat; index += 1) flags.push(value);
        }
      }
      const xs = [];
      let x = 0;
      for (let index = 0; index < pointCount; index += 1) {
        const flag = flags[index];
        if (flag & 0x02) { const step = buffer[cursor]; cursor += 1; x += (flag & 0x10) ? step : -step; }
        else if (!(flag & 0x10)) { x += i16(cursor); cursor += 2; }
        xs.push(x);
      }
      const ys = [];
      let y = 0;
      for (let index = 0; index < pointCount; index += 1) {
        const flag = flags[index];
        if (flag & 0x04) { const step = buffer[cursor]; cursor += 1; y += (flag & 0x20) ? step : -step; }
        else if (!(flag & 0x20)) { y += i16(cursor); cursor += 2; }
        ys.push(y);
      }
      const contours = [];
      let first = 0;
      for (const end of endPts) {
        const points = [];
        for (let index = first; index <= end; index += 1) {
          points.push({ x: xs[index], y: ys[index], onCurve: Boolean(flags[index] & 0x01) });
        }
        contours.push(points);
        first = end + 1;
      }
      return contours;
    }
    // glyph مركب: مكوّنات بإزاحات XY ومعاملات مقياس اختيارية.
    let cursor = start + 10;
    const contours = [];
    let flags = 0x20;
    while (flags & 0x20) {
      flags = u16(cursor);
      const componentGlyph = u16(cursor + 2);
      cursor += 4;
      let arg1; let arg2;
      if (flags & 0x01) { arg1 = i16(cursor); arg2 = i16(cursor + 2); cursor += 4; }
      else { arg1 = buffer.readInt8(cursor); arg2 = buffer.readInt8(cursor + 1); cursor += 2; }
      if (!(flags & 0x02)) throw new Error("TTF: glyph مركب بمطابقة نقاط غير مدعوم.");
      let scaleX = 1; let scaleY = 1; let scale01 = 0; let scale10 = 0;
      if (flags & 0x08) { scaleX = scaleY = i16(cursor) / 16384; cursor += 2; }
      else if (flags & 0x40) { scaleX = i16(cursor) / 16384; scaleY = i16(cursor + 2) / 16384; cursor += 4; }
      else if (flags & 0x80) {
        scaleX = i16(cursor) / 16384; scale01 = i16(cursor + 2) / 16384;
        scale10 = i16(cursor + 4) / 16384; scaleY = i16(cursor + 6) / 16384;
        cursor += 8;
      }
      for (const contour of glyphContours(componentGlyph, depth + 1)) {
        contours.push(contour.map((point) => ({
          x: point.x * scaleX + point.y * scale10 + arg1,
          y: point.x * scale01 + point.y * scaleY + arg2,
          onCurve: point.onCurve,
        })));
      }
    }
    return contours;
  }

  return { unitsPerEm, bbox, ascent, descent, advances, cmap, glyphContours };
}

// ---------- تشكيل العربية: أشكال العرض الأربعة ----------
// [منعزلة، آخر، أول، وسط] — صفر يعني أن الحرف يلتحم بما قبله فقط.
const arabicForms = new Map([
  [0x0621, [0xfe80, 0, 0, 0]],
  [0x0622, [0xfe81, 0xfe82, 0, 0]],
  [0x0623, [0xfe83, 0xfe84, 0, 0]],
  [0x0624, [0xfe85, 0xfe86, 0, 0]],
  [0x0625, [0xfe87, 0xfe88, 0, 0]],
  [0x0626, [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c]],
  [0x0627, [0xfe8d, 0xfe8e, 0, 0]],
  [0x0628, [0xfe8f, 0xfe90, 0xfe91, 0xfe92]],
  [0x0629, [0xfe93, 0xfe94, 0, 0]],
  [0x062a, [0xfe95, 0xfe96, 0xfe97, 0xfe98]],
  [0x062b, [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c]],
  [0x062c, [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0]],
  [0x062d, [0xfea1, 0xfea2, 0xfea3, 0xfea4]],
  [0x062e, [0xfea5, 0xfea6, 0xfea7, 0xfea8]],
  [0x062f, [0xfea9, 0xfeaa, 0, 0]],
  [0x0630, [0xfeab, 0xfeac, 0, 0]],
  [0x0631, [0xfead, 0xfeae, 0, 0]],
  [0x0632, [0xfeaf, 0xfeb0, 0, 0]],
  [0x0633, [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4]],
  [0x0634, [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8]],
  [0x0635, [0xfeb9, 0xfeba, 0xfebb, 0xfebc]],
  [0x0636, [0xfebd, 0xfebe, 0xfebf, 0xfec0]],
  [0x0637, [0xfec1, 0xfec2, 0xfec3, 0xfec4]],
  [0x0638, [0xfec5, 0xfec6, 0xfec7, 0xfec8]],
  [0x0639, [0xfec9, 0xfeca, 0xfecb, 0xfecc]],
  [0x063a, [0xfecd, 0xfece, 0xfecf, 0xfed0]],
  [0x0641, [0xfed1, 0xfed2, 0xfed3, 0xfed4]],
  [0x0642, [0xfed5, 0xfed6, 0xfed7, 0xfed8]],
  [0x0643, [0xfed9, 0xfeda, 0xfedb, 0xfedc]],
  [0x0644, [0xfedd, 0xfede, 0xfedf, 0xfee0]],
  [0x0645, [0xfee1, 0xfee2, 0xfee3, 0xfee4]],
  [0x0646, [0xfee5, 0xfee6, 0xfee7, 0xfee8]],
  [0x0647, [0xfee9, 0xfeea, 0xfeeb, 0xfeec]],
  [0x0648, [0xfeed, 0xfeee, 0, 0]],
  [0x0649, [0xfeef, 0xfef0, 0, 0]],
  [0x064a, [0xfef1, 0xfef2, 0xfef3, 0xfef4]],
]);
const tatweel = 0x0640;
const isArabicMark = (cp) => (cp >= 0x064b && cp <= 0x0652) || cp === 0x0670;
const isArabicLetter = (cp) => arabicForms.has(cp) || cp === tatweel;
const joinsForward = (cp) => cp === tatweel || (arabicForms.get(cp)?.[2] ?? 0) !== 0;
const joinsBackward = (cp) => cp === tatweel || (arabicForms.get(cp)?.[1] ?? 0) !== 0;

// يشكّل سطرًا عربيًا (اتجاه منطقي) إلى قائمة أشكال عرض بترتيب منطقي.
function shapeArabicRun(text) {
  const chars = [...text].map((char) => char.codePointAt(0));
  const result = [];
  for (let index = 0; index < chars.length; index += 1) {
    const cp = chars[index];
    if (isArabicMark(cp)) { result.push({ glyphCode: cp, logicalChar: String.fromCodePoint(cp) }); continue; }
    if (!isArabicLetter(cp)) { result.push({ glyphCode: cp, logicalChar: String.fromCodePoint(cp) }); continue; }
    if (cp === tatweel) { result.push({ glyphCode: tatweel, logicalChar: "ـ" }); continue; }
    let prev = -1;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (isArabicMark(chars[back])) continue;
      prev = chars[back];
      break;
    }
    let next = -1;
    for (let forward = index + 1; forward < chars.length; forward += 1) {
      if (isArabicMark(chars[forward])) continue;
      next = chars[forward];
      break;
    }
    const joinsPrev = prev >= 0 && joinsForward(prev) && joinsBackward(cp);
    const joinsNext = next >= 0 && joinsBackward(next) && joinsForward(cp);
    const forms = arabicForms.get(cp);
    const form = joinsPrev && joinsNext ? forms[3] : joinsPrev ? forms[1] : joinsNext ? forms[2] : forms[0];
    result.push({ glyphCode: form, logicalChar: String.fromCodePoint(cp) });
  }
  return result;
}

// ---------- ثنائية الاتجاه المبسطة: فقرة RTL، الأرقام واللاتينية LTR ----------
function charClass(cp) {
  if (isArabicLetter(cp) || isArabicMark(cp)) return "R";
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
    || (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9)
    || cp === 0x25 || cp === 0x066a || cp === 0x2e || cp === 0x066b || cp === 0x2c
    || cp === 0x066c || cp === 0x2f || cp === 0x2d || cp === 0x2b) return "L";
  return "N";
}

// يعيد قائمة glyphs بترتيب مرئي (يسار→يمين) مع ربط كل glyph بحرفه المنطقي.
export function layoutArabicLine(line) {
  const chars = [...line].map((char) => ({ char, cp: char.codePointAt(0) }));
  const runs = [];
  for (const item of chars) {
    const cls = charClass(item.cp);
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.items.push(item);
    else runs.push({ cls, items: [item] });
  }
  // المحايدة بين متجانسين تتبعهما؛ % بين رقمية وغيرها تلحق الرقمية.
  const resolved = [];
  for (const run of runs) {
    const prev = resolved[resolved.length - 1];
    if (run.cls === "N" && prev) {
      const nextCls = runs[runs.indexOf(run) + 1]?.cls;
      if (nextCls === prev.cls && (prev.cls === "R" || prev.cls === "L")) {
        prev.items.push(...run.items);
        continue;
      }
      const onlyPercentSpace = run.items.every((item) => item.cp === 0x20 || item.cp === 0x25 || item.cp === 0x066a);
      if (onlyPercentSpace && (prev.cls === "L" || nextCls === "L")) {
        prev.items.push(...run.items);
        continue;
      }
    }
    resolved.push({ cls: run.cls, items: [...run.items] });
  }
  // تمريرة ثانية: دمج المقاطع المتجانسة المتجاورة الناتجة عن دمج المحايدة
  // (مثل ":" في "10:00" تلحق الرقمية السابقة فيجب أن تلحقها اللاحقة أيضًا).
  const mergedRuns = [];
  for (const run of resolved) {
    const prev = mergedRuns[mergedRuns.length - 1];
    if (prev && prev.cls === run.cls) prev.items.push(...run.items);
    else mergedRuns.push(run);
  }
  // اتجاه الفقرة RTL: ترتيب المقاطع معكوس؛ العربية تُشكّل ثم تُعكس glyphsها.
  const visual = [];
  for (const run of [...mergedRuns].reverse()) {
    if (run.cls === "R") {
      const shaped = shapeArabicRun(run.items.map((item) => item.char).join(""));
      for (let index = shaped.length - 1; index >= 0; index -= 1) visual.push(shaped[index]);
    } else {
      for (const item of run.items) visual.push({ glyphCode: item.cp, logicalChar: item.char });
    }
  }
  return visual;
}

// ---------- تحويل كنتورات TrueType (تربيعية) إلى مسارات PDF (تكعيبية) ----------
function contourToPath(points, penX, baselineY, scale) {
  if (!points.length) return "";
  const px = (point) => fmt(penX + point.x * scale);
  const py = (point) => fmt(baselineY + point.y * scale);
  const expanded = [];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first.onCurve) {
    if (!last.onCurve) {
      expanded.push({ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, onCurve: true });
    } else {
      expanded.push(last);
    }
  }
  expanded.push(...points);
  const ops = [];
  let current = expanded[0];
  ops.push(`${px(current)} ${py(current)} m`);
  let index = 1;
  while (index < expanded.length) {
    const point = expanded[index];
    if (point.onCurve) {
      ops.push(`${px(point)} ${py(point)} l`);
      current = point;
      index += 1;
      continue;
    }
    const control = point;
    const following = expanded[index + 1] || expanded[0];
    const target = following.onCurve
      ? following
      : { x: (control.x + following.x) / 2, y: (control.y + following.y) / 2, onCurve: true };
    const c1 = { x: current.x + (2 / 3) * (control.x - current.x), y: current.y + (2 / 3) * (control.y - current.y) };
    const c2 = { x: target.x + (2 / 3) * (control.x - target.x), y: target.y + (2 / 3) * (control.y - target.y) };
    ops.push(`${px(c1)} ${py(c1)} ${px(c2)} ${py(c2)} ${px(target)} ${py(target)} c`);
    current = target;
    index += following.onCurve ? 2 : 1;
  }
  ops.push("h");
  return ops.join("\n");
}

// ---------- باني PDF ----------
const pageWidth = 595;
const pageHeight = 842;
const fontSize = 14;
const lineHeight = 26;
const rightMargin = 545;
const firstBaseline = 792;

function utf16beHexWithBom(text) {
  const buffer = Buffer.alloc(2 + text.length * 2);
  buffer[0] = 0xfe;
  buffer[1] = 0xff;
  for (let index = 0; index < text.length; index += 1) buffer.writeUInt16BE(text.charCodeAt(index), 2 + index * 2);
  return buffer.toString("hex").toUpperCase();
}

export function buildBenchmarkPdf(pages, fontBuffer) {
  const font = parseTtf(fontBuffer);
  const scale = fontSize / font.unitsPerEm;
  const gidOf = (codepoint, context) => {
    const gid = font.cmap.get(codepoint);
    if (!gid) throw new Error(`لا يوجد glyph للرمز U+${codepoint.toString(16)} في خط المنصة (${context}).`);
    return gid;
  };

  // الطبقة النصية غير المرئية: CIDs = رموز Unicode نفسها (UTF-16BE + BOM).
  const usedTextCodes = new Set([0xfeff, 0x20]);
  const pageStreams = [];
  pages.forEach((lines, pageIndex) => {
    const ops = [];
    lines.forEach((line, lineIndex) => {
      const baselineY = firstBaseline - lineIndex * lineHeight;
      const visual = layoutArabicLine(line);
      // عرض السطر من advances الفعلية؛ سطر RTL يبدأ من الهامش الأيمن.
      const widths = visual.map((glyph) => font.advances[gidOf(glyph.glyphCode, `سطر ${lineIndex + 1} صفحة ${pageIndex + 1}`)] * scale);
      const totalWidth = widths.reduce((sum, width) => sum + width, 0);
      if (totalWidth > rightMargin - 40) {
        throw new Error(`سطر أطول من عرض الصفحة (${fmt(totalWidth)} > ${rightMargin - 40}): "${line.slice(0, 40)}…"`);
      }
      let cursor = rightMargin - totalWidth;
      visual.forEach((glyph, glyphIndex) => {
        const gid = gidOf(glyph.glyphCode, "طبقة مرئية");
        for (const contour of font.glyphContours(gid)) {
          ops.push(contourToPath(contour, cursor, baselineY, scale));
        }
        ops.push("f");
        cursor += widths[glyphIndex];
      });
      for (const char of line) usedTextCodes.add(char.codePointAt(0));
      ops.push(`BT /F2 ${fontSize} Tf 3 Tr 1 0 0 1 50 ${fmt(baselineY)} Tm <${utf16beHexWithBom(line)}> Tj ET`);
    });
    pageStreams.push(ops.join("\n"));
  });

  // ToUnicode: هوية لكل رمز مستخدم (الطبقة النصية تخزن Unicode المنطقي مباشرة).
  const sortedCodes = [...usedTextCodes].sort((a, b) => a - b);
  const bfchar = sortedCodes
    .map((code) => `<${code.toString(16).toUpperCase().padStart(4, "0")}> <${code.toString(16).toUpperCase().padStart(4, "0")}>`)
    .join("\n");
  const toUnicodeStream = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /BenchmarkArabic-UTF16 def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${sortedCodes.length} beginbfchar`,
    bfchar,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");

  // CIDToGIDMap: cid (رمز Unicode) → gid في الـsubset.
  const maxCode = Math.max(...sortedCodes);
  const gidMap = Buffer.alloc((maxCode + 1) * 2);
  for (const code of sortedCodes) gidMap.writeUInt16BE(code === 0xfeff ? 0 : gidOf(code, "CIDToGIDMap"), code * 2);

  const widthsArray = sortedCodes
    .filter((code) => code !== 0xfeff)
    .map((code) => `${code} [ ${font.advances[gidOf(code, "/W")] * 1000 / font.unitsPerEm} ]`)
    .join(" ");

  const objects = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontObjectId = 3 + pages.length * 2;
  const cidFontId = fontObjectId + 1;
  const descriptorId = fontObjectId + 2;
  const fontFileId = fontObjectId + 3;
  const gidMapId = fontObjectId + 4;
  const toUnicodeId = fontObjectId + 5;

  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  pages.forEach((_, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    // تدفق المحتوى (مسارات vector + طبقة نصية) مضغوط FlateDecode — المستخرج
    // المجمَّد يفكه عبر inflateSync، والحجم غير المضغوط كان يتجاوز سقف 1MB.
    const content = deflateSync(Buffer.from(pageStreams[index], "latin1"), { level: 9 }).toString("latin1");
    objects.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentId} 0 R /Resources << /Font << /F2 ${fontObjectId} 0 R >> >> >>`]);
    objects.push([contentId, { filters: "/FlateDecode", data: content }]);
  });

  const compressedFont = deflateSync(fontBuffer, { level: 9 });
  const fontHex = `${compressedFont.toString("hex").toUpperCase()}>`;
  const compressedGidMap = deflateSync(gidMap, { level: 9 });
  const gidMapHex = `${compressedGidMap.toString("hex").toUpperCase()}>`;

  objects.push([fontObjectId, `<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSansArabicSubset /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`]);
  objects.push([cidFontId, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSansArabicSubset /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorId} 0 R /CIDToGIDMap ${gidMapId} 0 R /DW 1000 /W [ ${widthsArray} ] >>`]);
  objects.push([descriptorId, `<< /Type /FontDescriptor /FontName /DejaVuSansArabicSubset /Flags 4 /FontBBox [${font.bbox.join(" ")}] /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.ascent} /ItalicAngle 0 /StemV 80 /FontFile2 ${fontFileId} 0 R >>`]);
  objects.push([fontFileId, { filters: "[ /ASCIIHexDecode /FlateDecode ]", data: fontHex }]);
  objects.push([gidMapId, { filters: "[ /ASCIIHexDecode /FlateDecode ]", data: gidMapHex }]);
  objects.push([toUnicodeId, `<< /Length ${Buffer.byteLength(toUnicodeStream)} >>\nstream\n${toUnicodeStream}\nendstream`]);

  // التجميع byte-accurate: كل شيء ASCII خارج التدفقات، والتدفقات ASCIIHex.
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let position = Buffer.byteLength("%PDF-1.4\n");
  for (const [id, body] of objects) {
    offsets.push([id, position]);
    const header = Buffer.from(`${id} 0 obj\n`, "latin1");
    let bodyBuffer;
    if (typeof body === "string") bodyBuffer = Buffer.from(`${body}\nendobj\n`, "latin1");
    else bodyBuffer = Buffer.from(`<< /Length ${Buffer.byteLength(body.data, "latin1")} /Filter ${body.filters} >>\nstream\n${body.data}\nendstream\nendobj\n`, "latin1");
    parts.push(header, bodyBuffer);
    position += header.length + bodyBuffer.length;
  }
  const xrefStart = position;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const [, byteOffset] of offsets) xref += `${String(byteOffset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

// ---------- مستخرج مستقل عن analysis-documents.mjs ----------
// يقرأ ToUnicode CMap ويفكّ أسطر الطبقة النصية عبرها (لا عبر إرشاد FEFF)،
// ويعيد الصفحات والأسطر بترتيبها المنطقي. يفشل على أي رمز غير معرّف —
// ما يمنع تسرب نص مشوه أو (cid:…) دون ملاحظة.
export function extractBenchmarkPdfLogicalText(buffer) {
  const latin = buffer.toString("latin1");
  const objects = new Map();
  for (const match of latin.matchAll(/(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const fontObject = [...objects.values()].find((body) => /\/Subtype\s*\/Type0/.test(body));
  if (!fontObject) throw new Error("PDF المنصة: لا يوجد خط Type0 مضمّن.");
  const toUnicodeRef = fontObject.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
  if (!toUnicodeRef) throw new Error("PDF المنصة: ToUnicode مفقود.");
  const toUnicodeBody = objects.get(Number(toUnicodeRef[1])) || "";
  const cmap = new Map();
  for (const match of toUnicodeBody.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)) {
    const target = match[2];
    let text = "";
    for (let index = 0; index + 3 < target.length + 1 && index + 4 <= target.length; index += 4) {
      text += String.fromCharCode(Number.parseInt(target.slice(index, index + 4), 16));
    }
    cmap.set(match[1].toUpperCase(), text);
  }
  const pagesObject = [...objects.values()].find((body) => /\/Type\s*\/Pages\b/.test(body));
  const kidOrder = [...pagesObject.matchAll(/(\d+)\s+0\s+R/g)].map((match) => Number(match[1]));
  const pages = [];
  for (const pageId of kidOrder) {
    const page = objects.get(pageId) || "";
    const contentsRef = page.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const streamBody = objects.get(Number(contentsRef?.[1])) || "";
    // تدفق مضغوط FlateDecode: يُقطع بالطول المعلن (لا regex هش أمام بايتات
    // ثنائية) ثم يُفك بحد إخراج أعلى من حجم الصفحة المعتاد بأمان.
    const lengthMatch = streamBody.match(/\/Length\s+(\d+)/);
    const streamStart = streamBody.match(/stream\r?\n/);
    if (!lengthMatch || !streamStart) throw new Error(`PDF المنصة: تدفق الصفحة ${pageId} غير قابل للقراءة.`);
    const declaredLength = Number(lengthMatch[1]);
    const startIndex = streamStart.index + streamStart[0].length;
    const raw = Buffer.from(streamBody.slice(startIndex, startIndex + declaredLength), "latin1");
    const content = /\/FlateDecode/.test(streamBody)
      ? inflateSync(raw, { maxOutputLength: maxExtractedStreamBytes }).toString("latin1")
      : raw.toString("latin1");
    const lines = [];
    for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      const hex = match[1].replace(/\s+/g, "").toUpperCase();
      let line = "";
      for (let index = 0; index + 4 <= hex.length; index += 4) {
        const code = hex.slice(index, index + 4);
        if (!cmap.has(code)) throw new Error(`رمز بلا ToUnicode (نص مشوه محتمل): ${code}`);
        line += cmap.get(code);
      }
      lines.push(line.replace(/^\uFEFF/, ""));
    }
    pages.push(lines);
  }
  return pages;
}
