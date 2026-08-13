export const detailTabNames = [
  "المعلومات الأساسية",
  "العناوين والمواعيد المتعلقة بالمنافسة",
  "مجال التصنيف وموقع التنفيذ والتقديم",
  "جداول الكميات",
  "المرفق",
  "اختيار المنافسة",
  "آليات المحتوى المحلي",
  "معايير التقييم",
];

const fieldDefinitions = [
  ["title", /^(?:اسم المنافسة|اسم المناقصة)$/],
  ["tenderNumber", /^(?:رقم المنافسة|رقم المناقصة)$/],
  ["reference", /^(?:الرقم المرجعي|رقم المرجع)$/],
  ["tenderType", /^(?:نوع المنافسة|أسلوب المنافسة)$/],
  ["platformStatus", /^(?:حالة المنافسة|مرحلة المنافسة)$/],
  ["agency", /^(?:الجهة الحكومي[ةه]|الجهة المالكة|اسم الجهة)$/],
  ["classification", /^مجال التصنيف$/],
  ["activity", /^(?:النشاط الأساسي|نشاط المنافسة)$/],
  ["subActivity", /^(?:النشاط الفرعي|التصنيف الفرعي)$/],
  ["location", /^(?:مكان التنفيذ|موقع التنفيذ|منطقة التنفيذ)$/],
  ["contractDuration", /^(?:مدة العقد|مدة التنفيذ|مدة المشروع)$/],
  ["bookletFee", /^(?:قيمة وثائق المنافسة|قيمة الكراسة)$/],
  ["insuranceRequired", /^هل التأمين من متطلبات المنافسة$/],
  ["offerStatus", /^حالة العرض$/],
  ["timeRemaining", /^الوقت المتبق[ىي]$/],
  ["guarantee", /^(?:مطلوب ضمان الإبتدائي|الضمان الابتدائي|قيمة الضمان الابتدائي|نسبة الضمان الابتدائي)$/],
  ["guaranteeAddress", /^(?:عنوان الضمان الإبتدائ[يى]|عنوان الضمان الابتدائ[يى])$/],
  ["finalGuarantee", /^الضمان النهائي$/],
  ["publishedAt", /^(?:تاريخ النشر|تاريخ نشر المنافسة)$/],
  ["deadline", /^(?:آخر موعد لتقديم العروض|تاريخ ووقت انتهاء تقديم العروض)$/],
  ["openingAt", /^(?:تاريخ ووقت فتح العروض|موعد فتح العروض)$/],
  ["questionsDeadline", /^(?:آخر موعد ل[إا]ستلام [إا]ل?استفسارات|آخر موعد لاستقبال الاستفسارات|موعد استلام الاستفسارات)$/],
  ["expectedAwardAt", /^التاريخ المتوقع للترسية$/],
  ["workStartAt", /^تاريخ بدء الأعمال\s*\/\s*الخدمات$/],
  ["questionsStartAt", /^بداية إرسال الأسئلة و الاستفسارات$/],
  ["maxAnswerDuration", /^اقصى مدة للاجابة على الاستفسارات$/],
  ["openingPlace", /^مكان فتح العرض$/],
  ["offerMethod", /^(?:طريقة تقديم العروض|آلية تقديم العروض)$/],
  ["description", /^(?:وصف المنافسة|الغرض من المنافسة|نطاق العمل)$/],
  ["quantitySummary", /^(?:جدول الكميات|جداول الكميات)$/],
];

export function cleanDetailText(value) {
  return String(value || "").replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function fieldKey(label) {
  const normalized = cleanDetailText(label).replace(/[：:]+$/, "").trim();
  return fieldDefinitions.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
}

export function parseDetailFields(sections) {
  const fields = {};
  for (const section of sections || []) {
    const lines = cleanDetailText(section.text).split("\n").map((line) => cleanDetailText(line)).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const colonMatch = lines[index].match(/^(.{2,80}?)[：:]\s*(.+)$/);
      if (colonMatch) {
        const key = fieldKey(colonMatch[1]);
        if (key && !fields[key]) fields[key] = colonMatch[2];
        continue;
      }
      const key = fieldKey(lines[index]);
      if (!key || fields[key]) continue;
      const value = lines.slice(index + 1, index + 4).find((line) => !fieldKey(line) && line !== section.name);
      if (value) fields[key] = value;
    }
  }
  return fields;
}

export function classifyAttachmentName(name) {
  const text = cleanDetailText(name);
  if (/جدول.*كم|كميات|boq/i.test(text)) return "boq";
  if (/غرام|جزاء|penalt/i.test(text)) return "penalties";
  if (/محتوى.*محلي|تفضيل.*سعري|local content/i.test(text)) return "localContent";
  if (/معايير.*(?:العروض|التقييم|التأهيل)|evaluation/i.test(text)) return "evaluation";
  if (/شرط|مواصف|كراسة|booklet/i.test(text)) return "booklet";
  if (/ملحق|نموذج|داعم/i.test(text)) return "supporting";
  return "supporting";
}

export function normalizeAttachmentNames(names) {
  const unique = new Map();
  for (const value of names || []) {
    const displayName = cleanDetailText(typeof value === "string" ? value : value?.displayName);
    if (!displayName || displayName.length > 220) continue;
    const key = displayName.toLocaleLowerCase("ar");
    if (!unique.has(key)) unique.set(key, { displayName, kind: classifyAttachmentName(displayName) });
  }
  return [...unique.values()];
}

export function buildDetailRecord({ reference, sourceUrl, pageTitle, sections, attachmentNames, inspectedAt = new Date().toISOString() }) {
  const cleanSections = (sections || [])
    .map((section) => ({ name: cleanDetailText(section.name), text: cleanDetailText(section.text) }))
    .filter((section) => section.name && section.text);
  const attachments = normalizeAttachmentNames(attachmentNames);
  return {
    reference: String(reference),
    status: "complete",
    inspectedAt,
    sourceUrl: String(sourceUrl || ""),
    pageTitle: cleanDetailText(pageTitle),
    fields: parseDetailFields(cleanSections),
    sections: cleanSections,
    attachments,
    downloaded: false,
  };
}
