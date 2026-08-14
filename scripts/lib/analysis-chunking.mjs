// تقسيم محتوى المستندات إلى أجزاء حتمية محدودة الحجم — P4-A0 / تشديد P4-A0R.
// القواعد الصارمة: لا جزء يتجاوز maxChars أبدًا؛ أي كتلة أطول من الحد تُقسم على
// حدود الكلمات إلى أجزاء ≤ maxChars تحتفظ بمصدرها نفسه وتُوسم #p1/#p2…؛
// العنوان يلتصق بما يليه ضمن الحد (وإن تعذر وقف وحيدًا)؛ صفوف الجدول عناصر
// مستقلة، وعند استمرار جدول في جزء جديد يُلصق صف الترويسة كسياق إن اتسع.
import { createHash } from "node:crypto";

export const defaultChunkOptions = { maxChars: 1200, overlapChars: 120 };

function chunkIdFor(documentId, ordinal, blockIds) {
  const hash = createHash("sha256").update(`${documentId}${ordinal}${blockIds.join(",")}`).digest("hex");
  return `chk-${hash.slice(0, 16)}`;
}

function sourceLabel(block) {
  if (block.source.pageNumber !== undefined) return { pageNumber: block.source.pageNumber };
  if (block.source.sheetName) return { sheetName: block.source.sheetName, cellRange: block.source.cellRange };
  return { section: block.source.section };
}

// تقسيم كتلة أطول من الحد على حدود الكلمات؛ كلمة مفردة أطول من الحد تُقطع قسرًا.
function splitOversizedBlock(block, maxChars) {
  if (block.text.length <= maxChars) return [block];
  const parts = [];
  let current = "";
  for (const word of block.text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    const candidate = current ? `${current} ${rest}` : rest;
    if (candidate.length <= maxChars) { current = candidate; continue; }
    if (current) { parts.push(current); current = ""; }
    while (rest.length > maxChars) { parts.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
    current = rest;
  }
  if (current) parts.push(current);
  return parts.map((text, index) => ({
    ...block,
    text,
    blockId: parts.length > 1 ? `${block.blockId}#p${index + 1}` : block.blockId,
  }));
}

function joinedLength(blocks) {
  return blocks.reduce((sum, block) => sum + block.text.length, 0) + Math.max(0, blocks.length - 1);
}

// التقسيم حتمي: نفس المستند يعطي نفس الأجزاء ونفس المعرفات في كل تشغيل،
// وكل جزء ≤ maxChars مهما كانت بنية الكتل الداخلة.
export function chunkAnalysisDocument(document, options = {}) {
  const { maxChars, overlapChars } = { ...defaultChunkOptions, ...options };
  if (!document?.blocks?.length) return [];
  const limit = Math.max(40, Math.floor(maxChars));
  const overlap = Math.max(0, Math.min(Math.floor(overlapChars), limit - 1));

  const splitBlocks = [];
  for (const block of document.blocks) splitBlocks.push(...splitOversizedBlock(block, limit));

  // أول صف لكل جدول: يُستخدم كسياق ترويسة عند استمرار الجدول في جزء لاحق.
  const headerByTable = new Map();
  for (const block of splitBlocks) {
    if (block.tableId && !headerByTable.has(block.tableId)) headerByTable.set(block.tableId, block);
  }

  const chunks = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const ordinal = chunks.length + 1;
    const text = current.map((block) => block.text).join("\n");
    chunks.push({
      chunkId: chunkIdFor(document.documentId, ordinal, current.map((block) => block.blockId)),
      ordinal,
      text,
      charCount: text.length,
      blockIds: current.map((block) => block.blockId),
      sources: [...new Map(current.map((block) => [JSON.stringify(sourceLabel(block)), sourceLabel(block)])).values()],
      tableIds: [...new Set(current.map((block) => block.tableId).filter(Boolean))],
    });
  };

  // ذيل التداخل: كتل ختامية صغيرة بمجموع ≤ overlapChars، مع ضمان التقدم (لا تكرار لا نهائي).
  const overlapTail = () => {
    const tail = [];
    let total = 0;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const block = current[index];
      if (total + block.text.length > overlap) break;
      tail.unshift(block);
      total += block.text.length;
    }
    return tail.length < current.length ? tail : current.slice(1);
  };

  let index = 0;
  while (index < splitBlocks.length) {
    const block = splitBlocks[index];
    const addedLength = (current.length ? 1 : 0) + block.text.length;
    if (current.length && joinedLength(current) + addedLength > limit) {
      // لا يُترك عنوان وحيدًا في ذيل الجزء: ينتقل إلى الجزء التالي ليلتصق بما يليه.
      const carry = current[current.length - 1].kind === "heading" ? [current.pop()] : [];
      const tail = carry.length ? [] : overlapTail();
      flush();
      current = [...tail, ...carry];
      if (carry.length && joinedLength(current) + 1 + block.text.length > limit) {
        // التعذر الكامل للإلصاق ضمن الحد: يقف العنوان وحيدًا استثنائيًا.
        flush();
        current = [];
      }
      // سياق ترويسة الجدول عند استمراره في جزء جديد، إن اتسع ضمن الحد.
      if (block.tableId && !current.some((item) => item.tableId === block.tableId)) {
        const header = headerByTable.get(block.tableId);
        if (header && header.blockId !== block.blockId && !current.some((item) => item.blockId === header.blockId)) {
          const withHeader = joinedLength([...current, header]) + 1 + block.text.length;
          if (withHeader <= limit) current.push(header);
        }
      }
      continue;
    }
    current.push(block);
    index += 1;
  }
  flush();
  return chunks;
}
