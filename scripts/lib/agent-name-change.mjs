// P5-F1R: تحديد حقول الاسم المتغيّرة فعلًا في ملف وكيل — دالة نقية بلا I/O.
// الغرض: ألا يدّعي النظام تغييرًا لم يحدث («تم حفظ الاسم عربي + إنجليزي» بينما
// غُيّر حقل واحد أو لا شيء)، وأن تُبنى رسالة الواجهة على واقعة قابلة للاختبار.
// القاعدة: الحقل غير المُرسَل (undefined) ⇒ غير متغيّر. والقيمة تُقارن بعد trim
// مقابل الحقل المخزَّن المقابل (name_ar / name_en).
export const agentNameFieldKeys = ["nameAr", "nameEn"];

const storedKeyByField = { nameAr: "name_ar", nameEn: "name_en" };

export function computeAgentNameChanges(current, incoming = {}) {
  const changed = [];
  for (const field of agentNameFieldKeys) {
    if (incoming?.[field] === undefined) continue;
    const next = String(incoming[field]).trim();
    const previous = String(current?.[storedKeyByField[field]] ?? "").trim();
    if (next !== previous) changed.push(field);
  }
  return changed;
}
