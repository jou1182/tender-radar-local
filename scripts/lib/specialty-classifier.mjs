// محرك التصنيف الحتمي — P5-C0 (وكيل «خالد»)
// كلمات مفتاحية على العنوان (وزن 3) والحقول الوصفية (وزن 1)؛ بلا LLM إطلاقًا.
// القاعدة قابلة للتعديل من الملف JSON دون لمس الكود. أي نص غير مطابق ⇒ fallback.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rulebookPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "specialty-rulebook.json",
);

let cachedRulebook = null;
export async function loadRulebook({ force = false } = {}) {
  if (!cachedRulebook || force) {
    cachedRulebook = JSON.parse(await readFile(rulebookPath, "utf8"));
  }
  return cachedRulebook;
}

function normalizeArabic(text) {
  return String(text || "")
    .toLocaleLowerCase("ar")
    .replaceAll("أ", "ا")
    .replaceAll("إ", "ا")
    .replaceAll("آ", "ا")
    .replaceAll("ة", "ه")
    .replaceAll("ـ", "");
}

export function classifyTender(tender, rulebook) {
  // بلا قواعد ممررة: استخدم الكاش المحمّل مسبقًا (loadRulebook تُستدعى عند إقلاع الخدمة)؛
  // وإن لم يُحمَّل الكاش بعد فالتصنيف يتجاوز بأمان إلى fallback.
  const rules = rulebook ?? cachedRulebook ?? {
    specialties: [], fallbackCode: "general-works", scoring: {},
  };
  const scoring = rules.scoring ?? {};
  const titleWeight = Number(scoring.titleMatchWeight ?? 3);
  const fieldWeight = Number(scoring.fieldMatchWeight ?? 1);

  const title = normalizeArabic(tender?.title);
  const haystackFields = normalizeArabic(
    [tender?.agency, tender?.activity, tender?.subActivity, tender?.quantitySummary, tender?.tenderType]
      .filter(Boolean)
      .join(" "),
  );

  const scores = [];
  for (const specialty of rules.specialties ?? []) {
    let score = 0;
    for (const rawKeyword of specialty.keywords ?? []) {
      const keyword = normalizeArabic(rawKeyword);
      if (!keyword) continue;
      // العنوان يُحتسب مرة واحدة بقيمته الأعلى؛ الحقول تُراكم نقاطًا محدودة.
      if (title.includes(keyword)) score += titleWeight;
      else if (haystackFields.includes(keyword)) score += fieldWeight;
    }
    if (score > 0) scores.push({ code: specialty.code, name: specialty.name, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const totalScore = scores.reduce((sum, item) => sum + item.score, 0);
  const winner = scores[0] ?? null;

  if (!winner) {
    return {
      specialtyCode: rules.fallbackCode ?? "general-works",
      confidence: 0,
      method: "rulebook",
      runnerUp: null,
      matchedKeywords: [],
    };
  }

  const minimumConfidence = Number(scoring.minimumConfidence ?? 0.5);
  const rawConfidence = totalScore ? winner.score / totalScore : 0;
  const confident = rawConfidence >= minimumConfidence;
  const second = scores[1] ?? null;

  return {
    specialtyCode: confident ? winner.code : (rules.fallbackCode ?? "general-works"),
    confidence: Math.round(rawConfidence * 100) / 100,
    method: "rulebook",
    runnerUp: second ? { code: second.code, name: second.name } : null,
    matchedKeywords: [{ code: winner.code, name: winner.name, score: winner.score }],
    demotedForLowConfidence: confident ? false : { winner: winner.code, rawConfidence },
  };
}

// تصنيف دفعة وحفظها في القاعدة (يُستدعى بعد كل جولة مزامنة مكتملة).
// المرجع غير الموجود بعد في tenders يُتخطى بهدوء (قيد المفتاح الأجنبي) —
// ستُصنف تلقائيًا في جولة لاحقة بعد دخولها القاعدة.
export async function classifyAndStoreTenders(repository, tenders, { rulebook: providedRulebook } = {}) {
  const rulebook = providedRulebook ?? await loadRulebook();
  let classified = 0;
  let skipped = 0;
  for (const tender of tenders ?? []) {
    if (!tender?.reference) continue;
    const verdict = classifyTender(tender, rulebook);
    try {
      repository.saveTenderClassification({
        tenderReference: tender.reference,
        specialtyCode: verdict.specialtyCode,
        confidence: verdict.confidence,
        method: verdict.method,
      });
      classified += 1;
    } catch {
      skipped += 1;
    }
  }
  return { classified, skipped, rulebookVersion: rulebook.version };
}
