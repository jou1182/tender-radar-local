// مخطط مخرجات النموذج الداخلي وإعادة بناء التقرير canonical — P4-M0BR0.
// النموذج لا يُنتج أي نص أو statement أو summary إطلاقًا: يحدد القرار واليقين
// ويوزع معرفات المرشحين [cand-...] على الفئات الاثنتي عشرة.
// هذا المخطط الداخلي (analysis-model-selection-v2) ديناميكي لكل مستند.
import {
  analysisFindingFields,
  confidenceValues,
  findingSeverityValues,
  preliminaryDecisionValues,
  validateAnalysisReport,
} from "./analysis-report.mjs";
import { materializeEvidenceFromCandidates } from "./analysis-evidence-candidates.mjs";

export const modelSelectionSchemaVersion = "analysis-model-selection-v2";

// حقول المخطط الداخلي v2: الفئات الاثنتا عشرة، القرار واليقين وأدلة القرار.
// لا توجد حقول للبيان statement أو الملخص executiveSummary أو التحذيرات warnings.
export const modelSelectionFields = Object.freeze([
  ...analysisFindingFields,
  "preliminaryDecision",
  "confidence",
  "decisionEvidenceIds",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

// JSON Schema الديناميكي لكل مستند (v2): يفرض خلو مخرجات النموذج من الحقول النصية.
export function buildModelSelectionSchema(candidates) {
  const allowedIds = (Array.isArray(candidates) ? candidates : []).map((candidate) => candidate.candidateId);
  return deepFreeze({
    type: "object",
    additionalProperties: false,
    required: [...modelSelectionFields],
    properties: {
      ...Object.fromEntries(analysisFindingFields.map((field) => [field, { $ref: "#/$defs/selectionFindingList" }])),
      preliminaryDecision: { enum: [...preliminaryDecisionValues] },
      confidence: { enum: [...confidenceValues] },
      decisionEvidenceIds: { type: "array", items: { enum: [...allowedIds] } }
    },
    $defs: {
      selectionFindingList: { type: "array", items: { $ref: "#/$defs/selectionFinding" } },
      selectionFinding: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "confidence", "evidenceIds"],
        properties: {
          severity: { enum: [...findingSeverityValues] },
          confidence: { enum: [...confidenceValues] },
          evidenceIds: { type: "array", minItems: 1, items: { enum: [...allowedIds] } }
        }
      }
    }
  });
}

// مدقق كلي لمخرجات النموذج للمخطط v2: يمنع أي حقل زائد أو مكرر أو نصي.
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

  for (const field of analysisFindingFields) {
    const value = selection[field];
    if (!Array.isArray(value)) { errors.push(`${field} يجب أن يكون مصفوفة findings.`); continue; }
    const findingFields = ["severity", "confidence", "evidenceIds"];
    value.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`${field}[${index}] ليس كائنًا.`);
        return;
      }
      for (const key of Object.keys(finding)) {
        if (!findingFields.includes(key)) {
          errors.push(`${field}[${index}]: حقل غير مسموح: ${key} (additionalProperties: false).`);
        }
      }
      for (const key of findingFields) {
        if (!(key in finding)) {
          errors.push(`${field}[${index}]: الحقل المطلوب مفقود: ${key}`);
        }
      }
      if (errors.length) return;

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

  for (const key of Object.keys(selection)) {
    if (!modelSelectionFields.includes(key)) {
      errors.push(`حقل غير مسموح في مخرجات النموذج: ${key} — المخطط الداخلي لا يقبل evidence أو أي حقل زائد.`);
    }
  }
  return errors;
}

// يعيد بناء تقرير analysis-report-v2 canonical حتميًا بالكامل — P4-M0BR0.
// هذا مسار مخرجات النموذج الصارم فقط:
// - statement يُبنى حرفيًا من مقتطفات الأدلة المنتمية للكتالوج (بفاصل محايد).
// - executiveSummary يُدمج حتميًا من بنود findings نفسها (مقتطفات حرفية
//   مجتازة للـgrounding بالبناء) — لا كلمة واقعية جديدة خارج corpus الأدلة.
// - warnings تبقى فارغة دائمًا: تحذيرات المستند/الكتالوج التشغيلية غير مؤسسة
//   في أدلة مختارة فلا تُنقل إلى التقرير إطلاقًا.
// - بلا بنود مؤسسة لا يوجد ملخص مؤسس: يفشل الاختيار بأمان بكود واضح
//   (AI_NO_GROUNDED_SELECTION) بدل حفظ أي ملخص مبدئي غير مؤسس.
// لا يُقبل أي حقل نصي من النموذج (statement/category/executiveSummary/warnings)
// في المدخل — validateModelSelection يرفضها جميعًا (additionalProperties: false).
export function materializeCanonicalReport(selection, catalog) {
  const candidates = catalog?.candidates || [];
  const errors = validateModelSelection(selection, candidates);
  if (errors.length) {
    throw selectionError(`مخرجات النموذج غير مطابقة للمخطط الداخلي: ${errors[0]}`, errors);
  }
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));

  const usedIds = [];
  const seen = new Set();
  const collect = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      usedIds.push(id);
    }
  };

  const report = {
    preliminaryDecision: selection.preliminaryDecision,
    confidence: selection.confidence,
    decisionEvidenceIds: [...selection.decisionEvidenceIds],
  };

  const allStatements = [];
  for (const field of analysisFindingFields) {
    report[field] = selection[field].map((finding) => {
      for (const id of finding.evidenceIds) collect(id);
      const excerpts = finding.evidenceIds.map((id) => {
        const candidate = byId.get(id);
        return candidate ? candidate.excerpt : "";
      }).filter(Boolean);
      const statement = excerpts.join("؛ ");

      allStatements.push(statement);
      return {
        category: field,
        statement: statement,
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceIds: [...finding.evidenceIds],
      };
    });
  }

  for (const id of selection.decisionEvidenceIds) collect(id);

  // فشل آمن واضح بدل fallback غير مؤسس: بلا بنود مؤسسة لا يمكن بناء ملخص
  // حرفي من الأدلة، وأي ملخص آخر سيُدخل كلمات غير موجودة في corpus الأدلة.
  if (!allStatements.length) {
    const error = new Error(
      "لا توجد بنود مؤسسة في اختيار النموذج؛ لا يمكن بناء تقرير canonical بمقتطفات أدلة حرفية.",
    );
    error.code = "AI_NO_GROUNDED_SELECTION";
    throw error;
  }

  // ملخص حتمي مؤسس بالكامل: دمج بنود findings نفسها (مقتطفات حرفية) بفاصل
  // محايد، مع إزالة التكرار الحرفي حفاظًا على الحتمية والاختصار.
  report.executiveSummary = [...new Set(allStatements)].join("؛ ");

  report.warnings = [];
  report.evidence = materializeEvidenceFromCandidates(usedIds, catalog);

  const reportErrors = validateAnalysisReport(report);
  if (reportErrors.length) {
    throw selectionError(`فشل الفحص الذاتي للتقرير المعاد بناؤه: ${reportErrors[0]}`, reportErrors);
  }
  return report;
}

// بناء الـprompt المحدث للمخطط v2:
export function buildModelSelectionPrompt({ document, catalog }) {
  const lines = [
    `أنت محلل وثائق منافسات. أعد JSON فقط يطابق المخطط الداخلي ${modelSelectionSchemaVersion}.`,
    "مهمتك: تصنيف وتوزيع معرفات الأدلة من كتالوج المرشحين أدناه فقط على الفئات الاثنتي عشرة، وتحديد القرار واليقين.",
    "الفئات الاثنتا عشرة هي: scopeOfWork, boqSummary, criticalQuantities,",
    "eligibilityRequirements, requiredExperience, deadlines, bidBonds, guarantees, penalties,",
    "contractualRisks, unclearItems, questionsForAuthority.",
    "شكل كل finding في القائمة: {severity: info|low|medium|high|critical, confidence: low|medium|high, evidenceIds: [معرفات مرشحة]}.",
    "ملاحظة: لا تكتب أي نص أو statement أو ملخص. سيقوم النظام محلياً وحتمياً بإنشاء النصوص الحرفية والملخص والتحذيرات من مقتطفات الأدلة التي تختارها.",
    "evidenceIds: اختر واحدًا أو أكثر من معرفات [cand-...] المعروضة فقط — كل finding يحتاج دليلًا واحدًا على الأقل.",
    "decisionEvidenceIds: معرفات مرشحة تدعم preliminaryDecision؛ قرار enter أو review أو exclude يتطلب مصفوفة غير فارغة.",
    "preliminaryDecision إحدى: enter, review, exclude, insufficient_data — استخدم insufficient_data إذا لم توجد أدلة كافية.",
    "إن وُجدت قيمتان متعارضتان صراحةً لنفس الحقيقة (نفس البند، مدة أو تاريخ أو مبلغ مختلف) بين مقتطفات مختلفة — يُمنع اختيار أحدهما وحسم التعارض؛ يجب توجيه هذه الحالة إلى unclearItems أو questionsForAuthority فقط.",
    "confidence: low|medium|high.",
    "ممنوع منعًا باتًا: إضافة أي حقول زائدة، أو كتابة أي مقتطفات نصية، أو كتابة أي نصوص واقعية حرة.",
    "المقتطفات المعروضة منسوخة حرفيًا من المستند وهي مرجع للقراءة فقط لمساعدتك على الاختيار.",
    "أي مقتطف يبدو تنويهًا أو علامة تحذيرية تفيد أن الوثيقة بيانات اختبار اصطناعية أو ليست منافسة حقيقية — يُستبعد تمامًا من أي finding واقعي؛ لا يُعامل كشرط أهلية أو حقيقة من الوثيقة.",
    `معرف المستند: ${document.documentId}. نوعه: ${document.documentType}.`,
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
