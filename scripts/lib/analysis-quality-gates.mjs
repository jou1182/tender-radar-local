// P5-QGATES: بوابات جودة التحليل متعدد الملفات.
// دوال خالصة (بلا I/O) قابلة للاختبار بمعزل — تُقيّم (أ) هيمنة ملف واحد على
// الأدلة و(ب) تجزئة النص الحرفي داخل ملف واحد، لتجنب قرارات واثقة مضللة.

// (أ) نسبة الكتل المفردة (طول النص ≤2 حرف) من إجمالي كتل المستند.
// النص العربي المجزأ من PDF بلا ToUnicode يظهر ككتل من حرف واحد أو حرفين.
export function computeFragmentationRatio(blocks, { shortThreshold = 2 } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const short = blocks.filter((b) => {
    const text = typeof b?.text === "string" ? b.text : String(b?.text ?? "");
    return text.trim().length <= shortThreshold;
  }).length;
  return short / blocks.length;
}

// (ب) هل المستند "نص مجزأ"؟ — يتجاوز نسبة الكتل المفردة عتبة معينة (افتراضي 90%).
export function isFragmentedDocument(blocks, { ratio = 0.9, shortThreshold = 2 } = {}) {
  return computeFragmentationRatio(blocks, { shortThreshold }) > ratio;
}

// (ب-2) P5-PYMUPDF: كشف فقدان المحتوى العربي بصمت — نمط فشل مختلف عن التجزئة.
// بعض خطوط Type0 المدمجة تُسقط الأحرف العربية تمامًا من الاستخراج (تختفي دون أثر)
// بينما تبقى علامات الترقيم والأرقام والنص اللاتيني سليمة — فتظهر كتل كثيرة
// نصها الكامل بعد التقليم مجرد علامات ترقيم متكررة ("."، "،"، "-") من غير أي
// حرف فعلي. هذا لا يرفع نسبة التجزئة (الكتل ليست حروفًا مفردة) فيفلت من
// isFragmentedDocument تمامًا. عُيّرت العتبة الافتراضية (0.15) تجريبيًا مقابل
// مستندات حقيقية سليمة (نسبتها كلها <0.1) ومستندين حقيقيين معطوبين (0.26 و0.48).
const PURE_PUNCTUATION_RE = /^[.,،:؛;\-–—]+$/;

export function computePunctuationOnlyRatio(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const punctuationOnly = blocks.filter((b) => {
    const text = typeof b?.text === "string" ? b.text.trim() : "";
    return text.length > 0 && PURE_PUNCTUATION_RE.test(text);
  }).length;
  return punctuationOnly / blocks.length;
}

export function isArabicContentSuspiciouslyMissing(blocks, { ratio = 0.15 } = {}) {
  return computePunctuationOnlyRatio(blocks) > ratio;
}

// (ب-3) الحاجز الموحّد: هل يحتاج المستند مسار استخراج بديل؟ — تجزئة حرفية
// أو فقدان محتوى عربي صامت، أيهما وقع. عتبتان منفصلتان عمدًا (لا خيار
// `ratio` مشترك) لأن الحاجزين يقيسان ظاهرتين مختلفتين بمقاييس مختلفة تمامًا.
export function needsAlternateExtraction(blocks, { fragmentationRatio = 0.9, arabicLossRatio = 0.15, shortThreshold = 2 } = {}) {
  return isFragmentedDocument(blocks, { ratio: fragmentationRatio, shortThreshold })
    || isArabicContentSuspiciouslyMissing(blocks, { ratio: arabicLossRatio });
}

// (ج) تقييم توازن تغطية الأدلة عبر الملفات.
// المدخل: كائن { fileName: evidenceCount } لكل ملف تم تحليله (بما فيه المجزأ = 0).
// يقرر ما إذا كانت التغطية غير متوازنة بشكل يستدعي خفض الثقة:
//   1. نسبة أدلة ملف واحد ≥ dominantThreshold من الإجمالي، أو
//   2. عدد الملفات بصفر أدلة ≥2 من إجمالي الملفات.
export function assessCoverageBalance(perFileEvidenceCounts, { dominantThreshold = 0.8 } = {}) {
  const entries = Object.entries(perFileEvidenceCounts ?? {});
  const totalFiles = entries.length;
  const counts = entries.map(([, c]) => c);
  const totalEvidence = counts.reduce((a, b) => a + b, 0);
  const filesWithZero = counts.filter((c) => c === 0).length;
  const maxCount = counts.length ? Math.max(...counts) : 0;
  const dominantRatio = totalEvidence > 0 ? maxCount / totalEvidence : 0;

  const dominant = totalFiles > 0 && totalEvidence > 0 && dominantRatio >= dominantThreshold;
  const tooManyZero = filesWithZero >= 2;

  const unbalanced = dominant || tooManyZero;
  const reasons = [];
  if (dominant) reasons.push(`ملف واحد يحمل ${Math.round(dominantRatio * 100)}% من الأدلة`);
  if (tooManyZero) reasons.push(`${filesWithZero} من ${totalFiles} ملفات لم تساهم بأدلة`);

  return {
    totalFiles,
    totalEvidence,
    filesWithZero,
    dominantRatio,
    dominant,
    tooManyZero,
    unbalanced,
    reasons,
  };
}

// (د) رسالة تحذير التغطية الموحّدة — نص صريح كما طلبه المالك.
export function coverageWarningMessage(assessment) {
  if (!assessment?.unbalanced) return null;
  const n = assessment.filesWithZero;
  const m = assessment.totalFiles;
  return `التغطية غير متوازنة: ${n} من ${m} ملفات لم تساهم بأدلة`;
}
