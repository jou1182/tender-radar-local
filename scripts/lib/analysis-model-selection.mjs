// مخطط مخرجات النموذج الداخلي وإعادة بناء التقرير canonical — P4-A1D0.
// النموذج لا يُنتج evidence إطلاقًا: يكتب الملخص والنتائج ويختار معرفات مرشحين
// [cand-...] فقط. هذا المخطط الداخلي (analysis-model-selection-v1) ديناميكي لكل
// مستند لأن enum المعرفات يعتمد على كتالوج المرشحين، وهو لا يستبدل
// analysis-report-v2 الذي يبقى صيغة التقرير canonical المحفوظ في SQLite.
import {
  analysisFindingFields,
  analysisReportSchemaVersion,
  confidenceValues,
  findingSeverityValues,
  preliminaryDecisionValues,
  validateAnalysisReport,
} from "./analysis-report.mjs";
import { materializeEvidenceFromCandidates } from "./analysis-evidence-candidates.mjs";

export const modelSelectionSchemaVersion = "analysis-model-selection-v1";

// حقول المخطط الداخلي: كل حقول التقرير عدا evidence — لا يطلبها من النموذج أبدًا.
export const modelSelectionFields = Object.freeze([
  "executiveSummary",
  ...analysisFindingFields,
  "preliminaryDecision",
  "confidence",
  "decisionEvidenceIds",
  "warnings",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function selectionError(message, details) {
  const error = new Error(message);
  error.code = "AI_OUTPUT_INVALID";
  if (details) error.details = details;
  return error;
}

// JSON Schema الديناميكي لكل مستند: عناصر evidenceIds وdecisionEvidenceIds
// enum من معرفات المرشحين المسموحة فقط، والجذر additionalProperties=false بلا evidence.
export function buildModelSelectionSchema(candidates) {
  const allowedIds = (Array.isArray(candidates) ? candidates : []).map((candidate) => candidate.candidateId);
  return deepFreeze({
    type: "object",
    additionalProperties: false,
    required: [...modelSelectionFields],
    properties: {
      executiveSummary: { type: "string", minLength: 1 },
      ...Object.fromEntries(analysisFindingFields.map((field) => [field, { $ref: "#/$defs/selectionFindingList" }])),
      preliminaryDecision: { enum: [...preliminaryDecisionValues] },
      confidence: { enum: [...confidenceValues] },
      decisionEvidenceIds: { type: "array", items: { enum: [...allowedIds] } },
      warnings: { type: "array", items: { type: "string" } },
    },
    $defs: {
      selectionFindingList: { type: "array", items: { $ref: "#/$defs/selectionFinding" } },
      selectionFinding: {
        type: "object",
        additionalProperties: false,
        required: ["category", "statement", "severity", "confidence", "evidenceIds"],
        properties: {
          category: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          severity: { enum: [...findingSeverityValues] },
          confidence: { enum: [...confidenceValues] },
          evidenceIds: { type: "array", minItems: 1, items: { enum: [...allowedIds] } },
        },
      },
    },
  });
}

// مدقق كلي لمخرجات النموذج: لا يرمي TypeError إطلاقًا، ويعيد قائمة أخطاء عربية.
// يرفض المعرفات المجهولة والمكررة (داخل finding وفي decisionEvidenceIds)،
// وأي finding بلا دليل، وأي قرار نهائي بلا decisionEvidenceIds، وأي حقل زائد.
export function validateModelSelection(selection, candidates) {
  const errors = [];
  const allowedIds = new Set((Array.isArray(candidates) ? candidates : []).map((candidate) => candidate.candidateId));
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return ["مخرجات النموذج ليست كائن JSON صالحًا."];
  }
  for (const field of modelSelectionFields) {
    if (!(field in selection)) errors.push(`الحقل المطلوب مفقود: ${field}`);
  }
  if (errors.length) return errors;

  if (!isNonEmptyString(selection.executiveSummary)) errors.push("executiveSummary يجب أن يكون نصًا غير فارغ.");

  for (const field of analysisFindingFields) {
    const value = selection[field];
    if (!Array.isArray(value)) { errors.push(`${field} يجب أن يكون مصفوفة findings.`); continue; }
    value.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`${field}[${index}] ليس كائنًا.`);
        return;
      }
      if (!isNonEmptyString(finding.category)) errors.push(`${field}[${index}].category مفقودة.`);
      if (!isNonEmptyString(finding.statement)) errors.push(`${field}[${index}].statement مفقود.`);
      if (!findingSeverityValues.includes(finding.severity)) errors.push(`${field}[${index}].severity غير صالحة.`);
      if (!confidenceValues.includes(finding.confidence)) errors.push(`${field}[${index}].confidence غير صالحة.`);
      if (!Array.isArray(finding.evidenceIds) || !finding.evidenceIds.length || !finding.evidenceIds.every(isNonEmptyString)) {
        errors.push(`${field}[${index}].evidenceIds يجب أن تكون مصفوفة معرفات مرشحين غير فارغة.`);
        return;
      }
      const seen = new Set();
      for (const id of finding.evidenceIds) {
        if (seen.has(id)) errors.push(`${field}[${index}].evidenceIds يحتوي معرفًا مكررًا: ${id}.`);
        seen.add(id);
        if (!allowedIds.has(id)) errors.push(`${field}[${index}] يشير إلى معرف مرشح مجهول: ${id}.`);
      }
    });
  }

  if (!preliminaryDecisionValues.includes(selection.preliminaryDecision)) {
    errors.push(`preliminaryDecision غير صالحة؛ القيم المسموحة: ${preliminaryDecisionValues.join("، ")}.`);
  }
  if (!confidenceValues.includes(selection.confidence)) errors.push("confidence يجب أن تكون low أو medium أو high.");
  if (!isStringArray(selection.warnings)) errors.push("warnings يجب أن تكون مصفوفة نصوص.");

  if (!Array.isArray(selection.decisionEvidenceIds) || !selection.decisionEvidenceIds.every(isNonEmptyString)) {
    errors.push("decisionEvidenceIds يجب أن تكون مصفوفة معرفات مرشحين.");
  } else {
    const seen = new Set();
    for (const id of selection.decisionEvidenceIds) {
      if (seen.has(id)) errors.push(`decisionEvidenceIds يحتوي معرفًا مكررًا: ${id}.`);
      seen.add(id);
      if (!allowedIds.has(id)) errors.push(`decisionEvidenceIds يشير إلى معرف مرشح مجهول: ${id}.`);
    }
    if (["enter", "review", "exclude"].includes(selection.preliminaryDecision) && !selection.decisionEvidenceIds.length) {
      errors.push("قرار enter أو review أو exclude يتطلب decisionEvidenceIds غير فارغة من معرفات المرشحين.");
    }
  }

  // الحقول الزائدة تُفحص أخيرًا حتى يسبقها وصف الخلل البنيوي الأدق (مثل فئة ليست مصفوفة).
  for (const key of Object.keys(selection)) {
    if (!modelSelectionFields.includes(key)) {
      errors.push(`حقل غير مسموح في مخرجات النموذج: ${key} — المخطط الداخلي لا يقبل evidence أو أي حقل زائد.`);
    }
  }
  return errors;
}

// يعيد بناء تقرير analysis-report-v2 canonical من البيانات المحلية الموثوقة:
// evidence تُجمع من الكتالوج حرفيًا (evidenceId = candidateId مؤقتًا قبل التطبيع
// بنطاق المهمة في المحرك)، ثم يُمرر التقرير على validateAnalysisReport كفحص ذاتي.
// verifyReportGrounding وnormalizeReportEvidenceIds يطبقهما المحرك بعد ذلك بلا تخفيف.
export function materializeCanonicalReport(selection, catalog) {
  const candidates = catalog?.candidates || [];
  const errors = validateModelSelection(selection, candidates);
  if (errors.length) {
    throw selectionError(`مخرجات النموذج غير مطابقة للمخطط الداخلي: ${errors[0]}`, errors);
  }
  const usedIds = [];
  const seen = new Set();
  const collect = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      usedIds.push(id);
    }
  };
  const report = {
    executiveSummary: selection.executiveSummary,
    preliminaryDecision: selection.preliminaryDecision,
    confidence: selection.confidence,
    decisionEvidenceIds: [...selection.decisionEvidenceIds],
    warnings: [...selection.warnings],
  };
  for (const field of analysisFindingFields) {
    report[field] = selection[field].map((finding) => {
      for (const id of finding.evidenceIds) collect(id);
      return {
        category: finding.category,
        statement: finding.statement,
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceIds: [...finding.evidenceIds],
      };
    });
  }
  for (const id of selection.decisionEvidenceIds) collect(id);
  report.evidence = materializeEvidenceFromCandidates(usedIds, catalog);
  const reportErrors = validateAnalysisReport(report);
  if (reportErrors.length) {
    // اتساق داخلي مفترض: الكتالوج والمدقق يجب أن ينتجا تقريرًا صالحًا دائمًا.
    throw selectionError(`فشل الفحص الذاتي للتقرير المعاد بناؤه: ${reportErrors[0]}`, reportErrors);
  }
  return report;
}

// prompt v3: كتالوج نصي محدود للقراءة فقط — المعرف والموقع والمقتطف الحرفي.
// لا يحمل مسارات ملفات ولا بيانات اعتماد، وميزانية المقتطفات مضبوطة سلفًا في الكتالوج.
export function buildModelSelectionPrompt({ document, catalog }) {
  const lines = [
    `أنت محلل وثائق منافسات. أعد JSON فقط يطابق المخطط الداخلي ${modelSelectionSchemaVersion}.`,
    "مهمتك: كتابة الملخص والنتائج والاستنتاجات، واختيار معرفات الأدلة من كتالوج المرشحين أدناه فقط.",
    "الفئات الاثنتا عشرة (كل بند فيها finding موثق): scopeOfWork, boqSummary, criticalQuantities,",
    "eligibilityRequirements, requiredExperience, deadlines, bidBonds, guarantees, penalties,",
    "contractualRisks, unclearItems, questionsForAuthority.",
    "شكل كل finding: {category, statement, severity: info|low|medium|high|critical, confidence: low|medium|high, evidenceIds: [معرفات مرشحة]}.",
    "evidenceIds: اختر واحدًا أو أكثر من معرفات [cand-...] المعروضة فقط — كل finding يحتاج دليلًا واحدًا على الأقل.",
    "decisionEvidenceIds: معرفات مرشحة تدعم preliminaryDecision؛ قرار enter أو review أو exclude يتطلب مصفوفة غير فارغة.",
    "preliminaryDecision إحدى: enter, review, exclude, insufficient_data — استخدم insufficient_data إذا لم توجد أدلة كافية.",
    "ممنوع منعًا باتًا: اختراع معرف غير معروض، أو كتابة أي excerpt أو نسخه، أو كتابة موقع دليل (صفحة/ورقة/قسم)، أو إرجاع evidence objects.",
    "المقتطفات المعروضة منسوخة حرفيًا من المستند وهي مرجع للقراءة فقط لمساعدتك على الاختيار.",
    "الحقول المتبقية: executiveSummary نص غير فارغ، confidence: low|medium|high، warnings: [نصوص].",
    `معرف المستند: ${document.documentId}. نوعه: ${document.documentType}. سيُبنى من اختياراتك تقرير ${analysisReportSchemaVersion} canonical من البيانات المحلية الموثوقة.`,
    "كتالوج الأدلة المرشحة (للقراءة والاختيار بالمعرف فقط):",
  ];
  for (const candidate of catalog.candidates) {
    const location = candidate.pageNumber !== undefined
      ? `pageNumber=${candidate.pageNumber}`
      : candidate.sheetName !== undefined
        ? `sheetName=${candidate.sheetName}, cellRange=${candidate.cellRange}`
        : `section=${candidate.section}`;
    lines.push(`[${candidate.candidateId}] sourceType=${candidate.sourceType}; ${location}; chunkId=${candidate.chunkId}`);
    lines.push(candidate.excerpt);
  }
  return lines.join("\n");
}
