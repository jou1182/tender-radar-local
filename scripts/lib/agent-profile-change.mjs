// P5-F1R: حساب تغييرات ملف الوكيل + صياغة رسالة صادقة — وحدة نقية بلا I/O.
// استُخرجت بعد مراجعة مستقلة رصدت M1: واجهة ثانية (لوحة «فريق الوكلاء») كانت ترجع
// بصمت للاسم القديم وتُظهر «تم الحفظ ✓» دائمًا. فصارت الواجهتان تستخدمان نفس المنطق،
// ونفس صياغة الرسالة — فلا تتفرّق الحقيقة بين سطحين.
//
// القواعد:
// - حقل غير مُرسَل (undefined) ⇒ ليس تغييرًا.
// - قيمة غير نصية للاسم (null/0/false/كائن) ⇒ تُهمَل هنا ويرفضها المستودع (M2)؛
//   فلا ندّعي تغييرًا على مدخل غير صالح.
// - الـtrim قبل المقارنة، والمقارنة صارمة.

// الحقول المعروفة وأسماؤها العربية — مصدر واحد للتسمية في الواجهتين.
export const agentChangeLabels = {
  nameAr: "الاسم العربي",
  nameEn: "الاسم الإنجليزي",
  enabled: "حالة التشغيل",
  displayOrder: "الترتيب",
};

function normalizeName(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeFlag(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && (value === 0 || value === 1)) return value;
  return undefined;
}

function normalizeOrder(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function computeAgentProfileChanges(current, incoming = {}) {
  const changed = [];
  const nameAr = normalizeName(incoming?.nameAr);
  const nameEn = normalizeName(incoming?.nameEn);
  if (nameAr !== undefined && nameAr !== String(current?.name_ar ?? "")) changed.push("nameAr");
  if (nameEn !== undefined && nameEn !== String(current?.name_en ?? "")) changed.push("nameEn");

  const enabled = normalizeFlag(incoming?.enabled);
  if (enabled !== undefined && enabled !== Number(current?.enabled ?? 1)) changed.push("enabled");

  const displayOrder = normalizeOrder(incoming?.displayOrder);
  if (displayOrder !== undefined && displayOrder !== Number(current?.display_order ?? 99)) changed.push("displayOrder");

  return changed;
}

// رسالة واحدة صادقة تصلح للواجهتين — لا تقول «تم الحفظ» إن لم يتغيّر شيء،
// ولا تُخفِ حقلًا متغيّرًا بلا تسمية معروفة (ثقب صدق رصدته مراجعة مستقلة):
// الحقول المجهولة تُذكر بنصها الخام في بند «حقول أخرى» بدل إسقاطها.
export function describeAgentChanges(changed = []) {
  const fields = Array.isArray(changed) ? changed.filter((f) => typeof f === "string" && f) : [];
  const known = fields.filter((field) => agentChangeLabels[field]);
  const unknown = fields.filter((field) => !agentChangeLabels[field]);
  if (!known.length && !unknown.length) return "لا تغيير لحفظه — القيم كما هي.";
  const parts = known.map((field) => agentChangeLabels[field]);
  if (unknown.length) parts.push(`حقول أخرى (${unknown.join("، ")})`);
  return `تم حفظ ${parts.join(" + ")} ✓`;
}
