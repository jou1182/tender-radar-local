// P5-SHELL — البحث الذكي: خانة واحدة تفهم كل شيء (محلل حتمي بلا LLM)
// مرجع 12 رقمًا → قفزة مباشرة · منطقة/تخصص/رسوم/حالة → chips · الباقي → بحث نصي
import { useMemo, useState } from "react";

export type SmartChip = { kind: "region" | "specialty" | "fee" | "deadline" | "text"; label: string; value: string };
export type ParsedQuery = { chips: SmartChip[]; textQuery: string; directReference: string | null };

const REGION_WORDS = ["القصيم", "الرياض", "مكة المكرمة", "مكة", "المدينة المنورة", "المدينة", "الشرقية", "عسير", "تبوك", "حائل", "الحدود الشمالية", "الحدود", "جازان", "نجران", "الباحة", "الجوف"];
const SPECIALTY_WORDS = ["مباني", "طرق", "صيانة", "كهروميكانيكا", "ميكانيكا", "كهرباء", "مياه", "طاقة", "لاندسكيب", "حدائق", "هدم", "تقنية", "اتصالات", "تشطيبات", "أثاث", "أعمال عامة", "عامة"];
const DEADLINE_WORDS: [RegExp, string][] = [[/هذا الأسبوع|هذا الاسبوع/, "7"], [/اليوم|غدًا|غدا/, "1"], [/هذا الشهر/, "30"]];

// التصنيف الحتمي — يفصل chips عن نص البحث الحر
export function parseSmartQuery(input: string): ParsedQuery {
  const chips: SmartChip[] = [];
  let rest = ` ${input.trim()} `;

  // 1) مرجع كامل 12 رقمًا → قفزة مباشرة
  const refMatch = rest.match(/\b(\d{12})\b/);
  if (refMatch) {
    rest = rest.replace(refMatch[0], " ");
    return { chips: [{ kind: "region", label: `مرجع ${refMatch[1]}`, value: refMatch[1] }], textQuery: "", directReference: refMatch[1] };
  }

  // 2) المناطق
  for (const word of REGION_WORDS) {
    if (rest.includes(` ${word} `) || rest.includes(` ${word}؟`) || rest.endsWith(` ${word} `)) {
      const full = word === "مكة" ? "منطقة مكة المكرمة" : word === "المدينة" ? "منطقة المدينة المنورة" : word === "الحدود" ? "منطقة الحدود الشمالية" : word === "الشرقية" ? "المنطقة الشرقية" : `منطقة ${word}`;
      chips.push({ kind: "region", label: `منطقة: ${word}`, value: full });
      rest = rest.replace(` ${word} `, " ");
    }
  }

  // 3) التخصصات
  for (const word of SPECIALTY_WORDS) {
    if (rest.includes(word)) {
      chips.push({ kind: "specialty", label: `تخصص: ${word}`, value: word });
      rest = rest.replace(word, " ");
    }
  }

  // 4) الرسوم
  if (/مجاني|مجانًا|مجانا|بدون رسوم|صفر/.test(rest)) {
    chips.push({ kind: "fee", label: "رسوم: مجانية", value: "0" });
    rest = rest.replace(/مجاني|مجانًا|مجانا|بدون رسوم|صفر/g, " ");
  } else if (/مدفوع|مدفوعة/.test(rest)) {
    chips.push({ kind: "fee", label: "رسوم: مدفوعة", value: "paid" });
    rest = rest.replace(/مدفوع|مدفوعة/g, " ");
  }

  // 5) المدة المتبقية
  for (const [pattern, days] of DEADLINE_WORDS) {
    if (pattern.test(rest)) {
      chips.push({ kind: "deadline", label: `تُختم خلال ${days} يوم`, value: days });
      rest = rest.replace(pattern, " ");
      break;
    }
  }

  const textQuery = rest.replace(/\s+/g, " ").trim();
  if (textQuery) chips.push({ kind: "text", label: `نص: ${textQuery}`, value: textQuery });
  return { chips, textQuery, directReference: null };
}

function deadlineCutoff(days: number): number {
  return Date.now() + days * 86_400_000;
}

type Tender = { id: string; reference: string; title: string; region: string; fee: number; deadline: string; activity?: string; sub_activity?: string };

export function SmartSearch({ tenders, onJump, onApply }: {
  tenders: Tender[];
  onJump: (reference: string) => void;
  onApply: (parsed: ParsedQuery) => void;
}) {
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);

  const results = useMemo(() => {
    if (!parsed) return null;
    if (parsed.directReference) return tenders.filter((t) => t.reference === parsed.directReference);
    let list = tenders;
    for (const chip of parsed.chips) {
      if (chip.kind === "region") list = list.filter((t) => t.region.includes(chip.value));
      if (chip.kind === "specialty") list = list.filter((t) => `${t.activity ?? ""}${t.sub_activity ?? ""}${t.title}`.includes(chip.value));
      if (chip.kind === "fee") list = list.filter((t) => chip.value === "0" ? t.fee === 0 : t.fee > 0);
      if (chip.kind === "deadline") {
        const cutoff = deadlineCutoff(Number(chip.value));
        list = list.filter((t) => { const d = Date.parse(t.deadline); return Number.isFinite(d) && d <= cutoff; });
      }
      if (chip.kind === "text") list = list.filter((t) => t.title.includes(chip.value));
    }
    return list;
  }, [parsed, tenders]);

  function run() {
    const p = parseSmartQuery(input);
    setParsed(p);
    if (p.directReference) onJump(p.directReference);
    else onApply(p);
  }

  return (
    <section className="smart-search" aria-label="البحث الذكي">
      <div className="smart-search-head">
        <p className="eyebrow">اكتب بأي طريقة — نفهم فلاترك تلقائيًا</p>
        <h2>🔍 البحث الذكي</h2>
        <p>اسم منافسة، رقم مرجعي، منطقة، تخصص، مجاني أو مدفوع، قريبة الخاتمة — كل ذلك في سطر واحد.</p>
      </div>
      <div className="smart-search-bar">
        <input
          placeholder='مثال: "قصيم مباني مجاني" أو "260839006073" أو "طرق حائل هذا الأسبوع"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
        />
        <button type="button" disabled={!input.trim()} onClick={run}>بحث</button>
      </div>
      {parsed && (
        <div className="smart-chips" aria-label="الفلاتر المفهومة">
          {parsed.chips.length === 0 && <span className="smart-hint">لم أتعرف على فلاتر — سيبحث نصيًا في كل الحقول.</span>}
          {parsed.chips.map((chip, index) => (
            <span key={`${chip.kind}-${index}`} className={`smart-chip chip-${chip.kind}`}>
              {chip.label}
              <button type="button" aria-label={`إزالة ${chip.label}`} onClick={() => {
                const next = { ...parsed, chips: parsed.chips.filter((_, i) => i !== index) };
                setParsed(next); onApply(next);
              }}>×</button>
            </span>
          ))}
        </div>
      )}
      {results && (
        <div className="smart-results">
          <b>{results.length} نتيجة مطابقة</b>
          {parsed?.directReference && !results.length && <em className="test-error">لا توجد منافسة بهذا المرجع في قاعدتك.</em>}
          <ul>
            {results.slice(0, 8).map((t) => (
              <li key={t.id}>
                <b>{t.title}</b>
                <small>{t.reference} · {t.region} · {t.fee === 0 ? "مجانية" : `${t.fee} ر.س`}</small>
                <button type="button" className="quiet" onClick={() => onJump(t.reference)}>فتح</button>
              </li>
            ))}
          </ul>
          {results.length > 8 && <small>و{results.length - 8} أخرى — افتح قسم المنافسات لعرضها كلها بنفس الفلاتر.</small>}
        </div>
      )}
    </section>
  );
}
