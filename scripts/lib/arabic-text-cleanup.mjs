// P5-B1B: تنقية النص المستخرج قبل التحليل — تنظيف شوائب ar-SA/Page/تكرارات + RTL fix
// المخرجات الحية أثبتت: النموذج يرى نصًا ملوثًا بـ"ar-SA" المتكررة (نص إعدادات الصفحة في PDF)
export function cleanExtractedText(text) {
  let t = String(text || "");
  // 1) إزالة تكرارات ar-SA (إعدادات لغة الصفحة المتسربة من PDF)
  t = t.replace(/\bar-SA\b/g, " ");
  // 2) إزالة "Page N of M" من رؤوس الترقيم
  t = t.replace(/\bPage\s+\d+\s+of\s+\d+\b/g, " ");
  // 3) إزالة الرموز الزخرفية المتكررة (bullets من Wingdings)
  t = t.replace(/[•▪◦·]+/g, " ");
  // 4) تطبيع المسافات
  t = t.replace(/\s{2,}/g, " ").trim();
  // 5) معالجة العربية المعكوسة بصريًا (extracted visual order): عكس كل سطر عربي خالص
  //    لا نعكس الأسطر المختلطة لأن عكسها الكامل يشوه الأرقام واللاتيني
  const lines = t.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const arabicChars = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
    const totalChars = trimmed.replace(/\s/g, "").length;
    // سطر عربي خالص (أكثر من 70% عربية) نعكسه ليصبح منطقي الترتيب
    if (totalChars > 0 && arabicChars / totalChars > 0.7) {
      return [...trimmed].reverse().join("").replace(/\s{2,}/g, " ");
    }
    return trimmed;
  });
  return lines.filter(Boolean).join("\n");
}
