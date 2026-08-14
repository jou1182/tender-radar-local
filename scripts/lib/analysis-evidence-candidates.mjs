// كتالوج الأدلة الحرفية الحتمي — P4-A1D0.
// يستخرج مقتطفات حرفية من كتل المستند الأصلية (لا من نص أنشأه نموذج)، ويربطها
// بالأجزاء (chunks) ومصادرها، ويمنحها معرفات cand- مشتقة بـSHA-256 من مدخلاتها.
// النموذج لا يرى من هذا الكتالوج إلا المعرف والموقع والمقتطف للقراءة فقط،
// والبرنامج وحده يبني evidence النهائية من هذه البيانات المحلية الموثوقة.
import { createHash } from "node:crypto";

// حدود ثابتة قابلة للاختبار: 48 مرشحًا كحد أقصى، 6000 حرف إجمالي للمقتطفات،
// 400 حرف لكل مقتطف، و8 أحرف حدًا أدنى (المقاطع الأقصر تُدمج مع جارها أو تُسقط).
export const evidenceCandidateLimits = Object.freeze({
  maxCandidates: 48,
  maxTotalExcerptChars: 6_000,
  maxExcerptChars: 400,
  minExcerptChars: 8,
});

// تطبيع المسافات نفسه المستخدم في verifyReportGrounding: كل مقتطف مرشح
// substring حرفي من نص الكتلة ونص الجزء بعد هذا التطبيع بالضبط.
function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function locationKeyOf(source) {
  if (source?.pageNumber !== undefined) return `page:${source.pageNumber}`;
  if (source?.sheetName !== undefined) return `sheet:${source.sheetName}!${source.cellRange || ""}`;
  return `section:${source?.section || ""}`;
}

// معرف حتمي ثابت: نفس المستند والمدخلات ينتجان المعرف نفسه، وأي تغيير في النص
// أو الموقع أو الإزاحات ينتج معرفًا مختلفًا. لا randomUUID إطلاقًا.
export function createEvidenceCandidateId({ checksum, documentId, blockId, chunkId, source, startOffset, endOffset, excerpt }) {
  const canonical = [
    checksum || "",
    documentId || "",
    blockId || "",
    chunkId || "",
    locationKeyOf(source),
    String(startOffset),
    String(endOffset),
    excerpt || "",
  ].join("|");
  return `cand-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

// نهايات الجمل العربية والإنجليزية: التقسيم بعدها مع إبقاء العلامة داخل المقطع.
const sentenceBoundary = /(?<=[.!؟?؛…])\s+/;

// قطعة تتجاوز الحد تُقسم عند أقرب مسافة قبل الحد؛ فإن تعذر (كلمة متصلة طويلة)
// قُطعت قسرًا عند الحد نفسه — حتمي في الحالتين.
function splitOversizedSegment(text, maxChars) {
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars - 1);
    if (cut < Math.floor(maxChars / 2)) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

// يستخرج مقاطع كتلة واحدة بإزاحاتها داخل نصها المطبع: يبدأ بالأسطر غير الفارغة،
// ولا يقسم عند الجمل إلا إذا تجاوز السطر الحد، ولا يعبر أي مقطع حدود الكتلة.
// المقاطع الأقصر من الحد الأدنى تُدمج مع جارها المتصل (المدمج يبقى substring
// حرفيًا لأن الفواصل في النص المطبع مسافات مفردة) أو تُسقط إن تعذر الدمج.
function extractBlockSegments(text, { maxExcerptChars, minExcerptChars }) {
  const normalized = normalizeSpaces(text);
  if (!normalized) return { normalized, segments: [] };
  const rawSegments = [];
  const seenTexts = new Set();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = normalizeSpaces(rawLine);
    if (!line) continue;
    const pieces = line.length <= maxExcerptChars ? [line] : line.split(sentenceBoundary).filter(Boolean);
    for (const piece of pieces) {
      for (const segment of piece.length <= maxExcerptChars ? [piece] : splitOversizedSegment(piece, maxExcerptChars)) {
        if (seenTexts.has(segment)) continue; // إزالة التكرار الحرفي داخل المصدر نفسه: الأول يبقى
        seenTexts.add(segment);
        rawSegments.push(segment);
      }
    }
  }
  const located = [];
  let cursor = 0;
  for (const segment of rawSegments) {
    const start = normalized.indexOf(segment, cursor);
    if (start < 0) continue; // لا يحدث عمليًا: كل قطعة مشتقة من النص المطبع نفسه
    located.push({ text: segment, startOffset: start, endOffset: start + segment.length });
    cursor = start + segment.length;
  }
  const merged = [];
  for (const segment of located) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < minExcerptChars && segment.endOffset - last.startOffset <= maxExcerptChars) {
      last.text = normalized.slice(last.startOffset, segment.endOffset);
      last.endOffset = segment.endOffset;
      continue;
    }
    merged.push({ ...segment });
  }
  // مقطع ختامي قصير يُدمج رجوعًا في سابقه إن اتسع.
  const tail = merged[merged.length - 1];
  if (merged.length > 1 && tail && tail.text.length < minExcerptChars) {
    const previous = merged[merged.length - 2];
    if (tail.endOffset - previous.startOffset <= maxExcerptChars) {
      previous.text = normalized.slice(previous.startOffset, tail.endOffset);
      previous.endOffset = tail.endOffset;
      merged.pop();
    }
  }
  return {
    normalized,
    segments: merged.filter((segment) => segment.text.length >= minExcerptChars && segment.text.length <= maxExcerptChars),
  };
}

function entryOrder(entry) {
  const match = entry.match(/#p(\d+)$/);
  return match ? Number(match[1]) : 0;
}

// يبني الكتالوج كاملًا ثم يقصه حتميًا عند الحدود. يعيد أيضًا عدد المستبعد
// وتحذيرًا داخليًا به — بلا مسارات ملفات ولا أي بيانات اعتماد.
export function buildEvidenceCandidateCatalog({ document, chunks, limits } = {}) {
  const config = { ...evidenceCandidateLimits, ...(limits || {}) };
  const empty = { candidates: [], warnings: [], excludedCount: 0, generatedCount: 0, totalExcerptChars: 0 };
  if (!document || !Array.isArray(document.blocks)) return empty;

  const normalizedChunkText = new Map();
  const firstChunkByEntry = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk.chunkId !== "string") continue;
    if (!normalizedChunkText.has(chunk.chunkId)) normalizedChunkText.set(chunk.chunkId, normalizeSpaces(chunk.text));
    for (const entry of Array.isArray(chunk.blockIds) ? chunk.blockIds : []) {
      if (typeof entry === "string" && !firstChunkByEntry.has(entry)) firstChunkByEntry.set(entry, chunk);
    }
  }

  const generated = [];
  const seenIds = new Set();
  for (const block of document.blocks) {
    if (!block || typeof block.blockId !== "string" || typeof block.text !== "string") continue;
    const source = block.source || {};
    const hasLocation = source.pageNumber !== undefined || source.sheetName !== undefined || source.section !== undefined;
    if (!hasLocation) continue; // لا مرشح بلا مصدر وموقع
    const { segments } = extractBlockSegments(block.text, config);
    if (!segments.length) continue;
    // مداخل الكتلة داخل الأجزاء: الكتلة نفسه أو أجزاؤها المقسمة #p1/#p2… بترتيبها.
    const entries = [];
    for (const entry of firstChunkByEntry.keys()) {
      if (entry === block.blockId || entry.startsWith(`${block.blockId}#`)) entries.push(entry);
    }
    entries.sort((a, b) => entryOrder(a) - entryOrder(b));
    for (const entry of entries) {
      const chunk = firstChunkByEntry.get(entry);
      if (!chunk) continue; // لا مرشح بلا chunk
      const chunkText = normalizedChunkText.get(chunk.chunkId) || "";
      for (const segment of segments) {
        // مقاطع الكتلة المقسمة تُقبل فقط في الجزء الذي يحتويها حرفيًا فعلًا —
        // بهذا يجتاز كل مرشح verifyReportGrounding بالبناء لا بالصدفة.
        if (!chunkText.includes(segment.text)) continue;
        const candidateId = createEvidenceCandidateId({
          checksum: document.checksum,
          documentId: document.documentId,
          blockId: entry,
          chunkId: chunk.chunkId,
          source,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          excerpt: segment.text,
        });
        if (seenIds.has(candidateId)) continue; // لا candidateId مكرر إطلاقًا
        seenIds.add(candidateId);
        generated.push({
          candidateId,
          documentId: document.documentId,
          sourceType: document.documentType,
          ...(source.pageNumber !== undefined ? { pageNumber: source.pageNumber } : {}),
          ...(source.sheetName !== undefined ? { sheetName: source.sheetName, cellRange: source.cellRange } : {}),
          ...(source.section !== undefined ? { section: source.section } : {}),
          excerpt: segment.text,
          chunkId: chunk.chunkId,
          blockId: entry,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
        });
      }
    }
  }

  // قص حتمي بالترتيب نفسه (ترتيب الكتل ثم الإزاحة): بلا أي اختيار عشوائي.
  const candidates = [];
  let totalExcerptChars = 0;
  for (const candidate of generated) {
    if (candidates.length >= config.maxCandidates) break;
    if (totalExcerptChars + candidate.excerpt.length > config.maxTotalExcerptChars) break;
    candidates.push(candidate);
    totalExcerptChars += candidate.excerpt.length;
  }
  const excludedCount = generated.length - candidates.length;
  const warnings = excludedCount > 0
    ? [`استُبعد ${excludedCount} مرشحًا لتجاوز حدود الكتالوج (${config.maxCandidates} مرشحًا / ${config.maxTotalExcerptChars} حرفًا).`]
    : [];
  return { candidates, warnings, excludedCount, generatedCount: generated.length, totalExcerptChars };
}

// يبني عناصر evidence النهائية من الكتالوج حرفيًا. أي معرف مجهول يُرفض فورًا
// بكود AI_OUTPUT_INVALID — لا اختراع ولا إصلاح تقريبي ولا fuzzy matching.
export function materializeEvidenceFromCandidates(ids, catalog) {
  const byId = new Map((catalog?.candidates || []).map((candidate) => [candidate.candidateId, candidate]));
  return (Array.isArray(ids) ? ids : []).map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      const error = new Error(`معرف دليل مجهول لا يوجد في كتالوج المرشحين: ${id}`);
      error.code = "AI_OUTPUT_INVALID";
      throw error;
    }
    return {
      evidenceId: candidate.candidateId,
      documentId: candidate.documentId,
      sourceType: candidate.sourceType,
      ...(candidate.pageNumber !== undefined ? { pageNumber: candidate.pageNumber } : {}),
      ...(candidate.sheetName !== undefined ? { sheetName: candidate.sheetName, cellRange: candidate.cellRange } : {}),
      ...(candidate.section !== undefined ? { section: candidate.section } : {}),
      excerpt: candidate.excerpt,
      chunkId: candidate.chunkId,
    };
  });
}
