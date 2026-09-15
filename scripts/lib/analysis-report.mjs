// صيغة تقرير التحليل المنظم والتحقق منها — P4-A0 / تشديد P4-A0R.
// حياد القرار التجاري (P5-EVIDENCE-SUFFICIENCY، قرار د. جو 2026-08-29): لا يوجد أي
// حقل قرار تجاري (enter/review/exclude) — evidenceSufficiency يصف فقط مدى كفاية
// الأدلة المستخرجة، وليس توصية بدخول أو استبعاد المنافسة. القرار للمستخدم دائمًا.
// غياب الأدلة يفرض "insufficient"، وكل finding بلا evidenceIds صالحة يرفض التقرير
// كاملًا، وevidenceSufficiency بقيمة sufficient/partial يتطلب sufficiencyEvidenceIds
// صريحة ومؤسسة.
export const analysisReportSchemaVersion = "analysis-report-v3";
// v3 (P4-A1D0): عقد التفاعل تغيّر — النموذج يختار معرفات مرشحين فقط ولا يكتب evidence.
// v5 (P5-EVIDENCE-SUFFICIENCY): استبدال preliminaryDecision (enter/review/exclude)
// بـevidenceSufficiency (sufficient/partial/insufficient) — إزالة أي دلالة قرار تجاري.
export const analysisPromptVersion = "p4a-prompt-v5";

export const evidenceSufficiencyValues = ["sufficient", "partial", "insufficient"];
export const findingSeverityValues = ["info", "low", "medium", "high", "critical"];
export const confidenceValues = ["low", "medium", "high"];

// فئات findings الاثنتا عشرة: كل بند مستخرج كائن finding موثق بأدلة.
// لا يبقى بلا دليل سوى executiveSummary (ملخص نصي) وwarnings (تحذيرات إجرائية).
export const analysisFindingFields = [
  "scopeOfWork",
  "boqSummary",
  "criticalQuantities",
  "eligibilityRequirements",
  "requiredExperience",
  "deadlines",
  "bidBonds",
  "guarantees",
  "penalties",
  "contractualRisks",
  "unclearItems",
  "questionsForAuthority",
];

export const analysisReportFields = [
  "executiveSummary",
  ...analysisFindingFields,
  "evidenceSufficiency",
  "confidence",
  "sufficiencyEvidenceIds",
  "warnings",
  "evidence",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// تجميد عميق محلي بسيط (P4-A1C0) — بلا dependency: يمنع أي تعديل وقت التشغيل
// على مخطط JSON الممرر إلى Ollama.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// JSON Schema محلي مطابق لعقد analysis-report-v3 (P4-A1C0): يُمرر إلى Ollama
// داخل حقل format لفرض البنية من المصدر. لا يحول كائنًا إلى مصفوفة ولا يصحح
// مخرجات النموذج؛ validateAnalysisReport يبقى الحاجز الإلزامي الثاني بعد الاستجابة.
// كائن JSON خالص: قابل للتسلسل الكامل بـJSON.stringify دون functions أو undefined.
export const analysisReportJsonSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [...analysisReportFields],
  properties: {
    executiveSummary: { type: "string", minLength: 1 },
    ...Object.fromEntries(analysisFindingFields.map((field) => [field, { $ref: "#/$defs/findingList" }])),
    evidenceSufficiency: { enum: [...evidenceSufficiencyValues] },
    confidence: { enum: [...confidenceValues] },
    // يسمح بالفراغ: المدقق يفرض عدم الفراغ فقط عند sufficient/partial.
    sufficiencyEvidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
    warnings: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
  },
  $defs: {
    // كل فئة من الفئات الاثنتي عشرة: مصفوفة findings قد تكون فارغة.
    findingList: { type: "array", items: { $ref: "#/$defs/finding" } },
    finding: {
      type: "object",
      additionalProperties: false,
      required: ["category", "statement", "severity", "confidence", "evidenceIds"],
      properties: {
        category: { type: "string", minLength: 1 },
        statement: { type: "string", minLength: 1 },
        severity: { enum: [...findingSeverityValues] },
        confidence: { enum: [...confidenceValues] },
        evidenceIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["evidenceId", "documentId", "sourceType", "excerpt", "chunkId"],
      properties: {
        evidenceId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        sourceType: { enum: ["pdf", "xlsx", "docx"] },
        excerpt: { type: "string", minLength: 1, maxLength: 400 },
        chunkId: { type: "string", minLength: 1 },
        pageNumber: { type: "integer", minimum: 1 },
        sheetName: { type: "string", minLength: 1 },
        cellRange: { type: "string", minLength: 1 },
        section: { type: "string", minLength: 1 },
      },
      // موقع واحد صالح على الأقل: صفحة، أو ورقة ونطاق معًا، أو قسم — بما لا يتعارض
      // مع متطلبات verifyReportGrounding لكل نوع مستند.
      anyOf: [
        { required: ["pageNumber"] },
        { required: ["sheetName", "cellRange"] },
        { required: ["section"] },
      ],
    },
  },
});

// يعيد قائمة أخطاء عربية؛ القائمة الفارغة تعني تقريرًا صالحًا.
export function validateAnalysisReport(report) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["التقرير ليس كائن JSON صالحًا."];
  }
  for (const field of analysisReportFields) {
    if (!(field in report)) errors.push(`الحقل المطلوب مفقود: ${field}`);
  }
  if (errors.length) return errors;

  if (!isNonEmptyString(report.executiveSummary)) errors.push("executiveSummary يجب أن يكون نصًا غير فارغ.");
  if (!evidenceSufficiencyValues.includes(report.evidenceSufficiency)) {
    errors.push(`evidenceSufficiency غير صالحة؛ القيم المسموحة: ${evidenceSufficiencyValues.join("، ")}.`);
  }
  if (!confidenceValues.includes(report.confidence)) errors.push("confidence يجب أن تكون low أو medium أو high.");
  if (!isStringArray(report.warnings)) errors.push("warnings يجب أن تكون مصفوفة نصوص.");

  for (const field of analysisFindingFields) {
    if (!Array.isArray(report[field])) { errors.push(`${field} يجب أن يكون مصفوفة findings.`); continue; }
    report[field].forEach((finding, index) => {
      if (!finding || typeof finding !== "object") { errors.push(`${field}[${index}] ليس كائنًا.`); return; }
      if (!isNonEmptyString(finding.category)) errors.push(`${field}[${index}].category مفقودة.`);
      if (!isNonEmptyString(finding.statement)) errors.push(`${field}[${index}].statement مفقود.`);
      if (!findingSeverityValues.includes(finding.severity)) errors.push(`${field}[${index}].severity غير صالحة.`);
      if (!confidenceValues.includes(finding.confidence)) errors.push(`${field}[${index}].confidence غير صالحة.`);
      if (!Array.isArray(finding.evidenceIds) || !finding.evidenceIds.length || !finding.evidenceIds.every(isNonEmptyString)) {
        errors.push(`${field}[${index}].evidenceIds يجب أن تكون مصفوفة معرفات أدلة غير فارغة.`);
      }
    });
  }

  if (!Array.isArray(report.evidence)) {
    errors.push("evidence يجب أن تكون مصفوفة.");
    return errors;
  }
  const evidenceIds = new Set();
  report.evidence.forEach((item, index) => {
    if (!item || typeof item !== "object") { errors.push(`evidence[${index}] ليس كائنًا.`); return; }
    if (!isNonEmptyString(item.evidenceId)) errors.push(`evidence[${index}].evidenceId مفقود.`);
    else evidenceIds.add(item.evidenceId);
    if (!isNonEmptyString(item.documentId)) errors.push(`evidence[${index}].documentId مفقود.`);
    if (!isNonEmptyString(item.sourceType)) errors.push(`evidence[${index}].sourceType مفقود.`);
    const hasLocation = item.pageNumber !== undefined || item.sheetName !== undefined || item.cellRange !== undefined || item.section !== undefined;
    if (!hasLocation) errors.push(`evidence[${index}] يحتاج pageNumber أو sheetName/cellRange أو section.`);
    if (!isNonEmptyString(item.excerpt) || item.excerpt.length > 400) errors.push(`evidence[${index}].excerpt مفقود أو يتجاوز 400 حرف.`);
    if (!isNonEmptyString(item.chunkId)) errors.push(`evidence[${index}].chunkId مفقود.`);
  });

  if (!Array.isArray(report.sufficiencyEvidenceIds) || !report.sufficiencyEvidenceIds.every(isNonEmptyString)) {
    errors.push("sufficiencyEvidenceIds يجب أن تكون مصفوفة معرفات أدلة.");
  }

  // سلامة المراجع بحواجز بنيوية صريحة (P4-A1R): لا يُمرّ على report[field] إلا
  // إذا كانت مصفوفة فعلًا، ولا على finding.evidenceIds إلا إذا كانت مصفوفة
  // فعلًا. أي قيمة JSON أخرى (كائن، نص، عدد، منطقية، null) سجّلها المرور الأول
  // خطأ تحقق، وهنا تُتخطى بأمان — المدقق دالة كلية لا ترمي TypeError إطلاقًا.
  for (const field of analysisFindingFields) {
    if (!Array.isArray(report[field])) continue;
    for (const finding of report[field]) {
      if (!finding || typeof finding !== "object") continue;
      if (!Array.isArray(finding.evidenceIds)) continue;
      for (const id of finding.evidenceIds) {
        if (isNonEmptyString(id) && !evidenceIds.has(id)) {
          errors.push(`الدليل ${id} المشار إليه في ${field} غير موجود في evidence.`);
        }
      }
    }
  }
  for (const id of Array.isArray(report.sufficiencyEvidenceIds) ? report.sufficiencyEvidenceIds : []) {
    if (isNonEmptyString(id) && !evidenceIds.has(id)) errors.push(`دليل الكفاية ${id} غير موجود في evidence.`);
  }

  // القاعدة الصارمة: لا تقييم كفاية إيجابي بلا أدلة؛ غياب الأدلة يفرض "insufficient".
  if (!report.evidence.length && report.evidenceSufficiency !== "insufficient") {
    errors.push("لا يجوز إصدار evidenceSufficiency غير insufficient بلا أدلة؛ استخدم insufficient عند غياب الأدلة.");
  }
  // evidenceSufficiency بقيمة sufficient أو partial يتطلب sufficiencyEvidenceIds صريحة غير فارغة.
  if (["sufficient", "partial"].includes(report.evidenceSufficiency)
    && (!Array.isArray(report.sufficiencyEvidenceIds) || !report.sufficiencyEvidenceIds.length)) {
    errors.push("evidenceSufficiency بقيمة sufficient أو partial يتطلب sufficiencyEvidenceIds غير فارغة تشير إلى أدلة موجودة.");
  }
  return errors;
}

export function assertValidAnalysisReport(report) {
  const errors = validateAnalysisReport(report);
  if (errors.length) {
    const error = new Error(`مخرجات التحليل غير مطابقة للصيغة: ${errors[0]}`);
    error.code = "ANALYSIS_OUTPUT_INVALID";
    error.details = errors;
    throw error;
  }
  return report;
}

export function emptyAnalysisReport({ summary = "لا توجد أدلة كافية لتحليل هذا المستند.", warnings = [] } = {}) {
  return {
    executiveSummary: summary,
    scopeOfWork: [],
    boqSummary: [],
    criticalQuantities: [],
    eligibilityRequirements: [],
    requiredExperience: [],
    deadlines: [],
    bidBonds: [],
    guarantees: [],
    penalties: [],
    contractualRisks: [],
    unclearItems: [],
    questionsForAuthority: [],
    evidenceSufficiency: "insufficient",
    confidence: "low",
    sufficiencyEvidenceIds: [],
    warnings,
    evidence: [],
  };
}

// تطبيع معرفات الأدلة قبل الحفظ: مزود قد يعيد ev-1..ev-N لكل مهمة فيتصادم المفتاح
// الأساسي بين المهمات. يعاد ترقيم كل دليل بنطاق المهمة، وتُعاد كتابة كل المراجع.
// المراجع غير المعروفة تُترك كما هي ليسقطها المدقق — دليل وهمي مرفوض دائمًا.
// أي evidenceId مكرر داخل التقرير نفسه يرفض فورًا قبل أي إعادة ترقيم.
export function normalizeReportEvidenceIds(report, scope) {
  const safeScope = String(scope || "job").replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "job";
  const idMap = new Map();
  const evidence = (Array.isArray(report?.evidence) ? report.evidence : []).map((item, index) => {
    const nextId = `ev-${safeScope}-${index + 1}`;
    if (item && isNonEmptyString(item.evidenceId)) {
      if (idMap.has(item.evidenceId)) {
        const error = new Error(`مخرجات التحليل غير مطابقة للصيغة: evidenceId مكرر داخل التقرير: ${item.evidenceId}`);
        error.code = "ANALYSIS_OUTPUT_INVALID";
        throw error;
      }
      idMap.set(item.evidenceId, nextId);
    }
    return { ...item, evidenceId: nextId };
  });
  const remap = (ids) => (Array.isArray(ids) ? ids.map((id) => idMap.get(id) || id) : []);
  const normalized = { ...report, evidence, sufficiencyEvidenceIds: remap(report?.sufficiencyEvidenceIds) };
  for (const field of analysisFindingFields) {
    normalized[field] = (Array.isArray(report?.[field]) ? report[field] : []).map((finding) => (
      finding && typeof finding === "object" ? { ...finding, evidenceIds: remap(finding.evidenceIds) } : finding
    ));
  }
  return normalized;
}

// التأسيس (grounding): كل دليل يجب أن يشير إلى مستند المهمة نفسه، وأن يقع موضعه
// (صفحة/ورقة+نطاق/قسم) ضمن مصادر الجزء المرجعي، وأن يكون مقتطفه — بعد تطبيع
// المسافات — جزءًا حرفيًا من نص الجزء. أي مخالفة تسقط التقرير كاملًا.
function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function verifyReportGrounding(report, document, chunks) {
  const chunkById = new Map((chunks || []).map((chunk) => [chunk.chunkId, chunk]));
  const fail = (evidenceId, reason) => {
    const error = new Error(`دليل غير مؤسس (${evidenceId || "؟"}): ${reason}`);
    error.code = "ANALYSIS_GROUNDING_FAILED";
    throw error;
  };
  for (const item of report.evidence || []) {
    if (item.documentId !== document.documentId) fail(item.evidenceId, "معرف المستند لا يطابق مستند المهمة.");
    if (item.sourceType !== document.documentType) fail(item.evidenceId, `sourceType (${item.sourceType}) لا يطابق نوع المستند (${document.documentType}).`);
    // متطلبات الموقع حسب نوع المستند: PDF صفحة صحيحة، XLSX ورقة ونطاق معًا، DOCX قسم.
    if (document.documentType === "pdf" && !(Number.isInteger(item.pageNumber) && item.pageNumber >= 1)) {
      fail(item.evidenceId, "دليل PDF يحتاج pageNumber صحيحًا (عددًا ≥ 1).");
    }
    if (document.documentType === "xlsx" && !(isNonEmptyString(item.sheetName) && isNonEmptyString(item.cellRange))) {
      fail(item.evidenceId, "دليل XLSX يحتاج sheetName وcellRange معًا.");
    }
    if (document.documentType === "docx" && !isNonEmptyString(item.section)) {
      fail(item.evidenceId, "دليل DOCX يحتاج section.");
    }
    const chunk = chunkById.get(item.chunkId);
    if (!chunk) fail(item.evidenceId, "الجزء المرجعي غير موجود في أجزاء المستند.");
    const locationOk = (chunk.sources || []).some((source) => {
      if (item.pageNumber !== undefined) return source.pageNumber === item.pageNumber;
      if (item.sheetName !== undefined) {
        return source.sheetName === item.sheetName && (item.cellRange === undefined || source.cellRange === item.cellRange);
      }
      if (item.section !== undefined) return source.section === item.section;
      return false;
    });
    if (!locationOk) fail(item.evidenceId, "الموضع (صفحة/ورقة/قسم) غير موجود في مصادر الجزء المرجعي.");
    if (!normalizeSpaces(chunk.text).includes(normalizeSpaces(item.excerpt))) {
      fail(item.evidenceId, "المقتطف ليس جزءًا حرفيًا من نص الجزء بعد تطبيع المسافات.");
    }
  }
  return true;
}
