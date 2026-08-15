// توليد RESUME_HERE.md من القالب والحالة الفعلية — P4-H1A.
// القالب يحمل عناصر نائبة {{TOKEN}} فقط؛ يمنع وجود حالة قديمة hard-coded فيه.
// كل القيم تُملأ من Git وSQLite ووثيقة continuity المنظمة وقت الإنشاء.

const TOKEN_PATTERN = /\{\{[A-Z_]+\}\}/g;

export class RecoveryResumeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecoveryResumeError";
    this.code = "recovery-resume";
    Object.assign(this, details);
  }
}

// يثبت أن القالب خالٍ من أي حالة قديمة ثابتة: لا Hash كامل ولا رموز مراحل.
export function assertTemplateHasNoHardcodedState(template) {
  if (/[0-9a-f]{40}/.test(template)) {
    throw new RecoveryResumeError("قالب RESUME_HERE يحتوي Hash commit ثابتًا — ممنوع", { stage: "resume-template" });
  }
  if (/P\d[‑-]?[A-Z0-9]+/i.test(template)) {
    throw new RecoveryResumeError("قالب RESUME_HERE يحتوي رمز مرحلة ثابتًا — ممنوع", { stage: "resume-template" });
  }
}

function renderStoppedGates(state) {
  const lines = [];
  const stages = state.attachmentLiveStages || {};
  if (stages.p3b1b) {
    const stage = stages.p3b1b;
    const noLiveInspection = stage.attachmentNameInspected === false && stage.downloadElementInspected === false && stage.fileDownloaded === false;
    lines.push(
      `- P3‑B1B: ${stage.status}${noLiveInspection ? " — دون فحص ملف حي ودون تنزيل أو استهلاك موافقة" : ""}. شرط الاستئناف: ${stage.resumeCondition || "غير مسجل"}`,
    );
  }
  if (stages.p3b1c) {
    lines.push(`- P3‑B1C: ${stages.p3b1c.status} — ${stages.p3b1c.reason || "متوقفة"}.`);
  }
  lines.push(`- ${state.nextPlannedPhase}: لم تبدأ.`);
  return lines.join("\n");
}

function renderTestBaselines(state) {
  const baselines = state.testBaselines || {};
  const lines = [];
  if (baselines.functionalBaseline) {
    lines.push(`- الأساس الوظيفي (${baselines.functionalBaseline.commit || "غير مسجل"}): نجاح ${baselines.functionalBaseline.passed} / فشل ${baselines.functionalBaseline.failed}.`);
  }
  if (baselines.continuityPackage) {
    lines.push(`- حزمة الاستمرارية (${baselines.continuityPackage.phase || "غير مسجل"}): نجاح ${baselines.continuityPackage.passed} / فشل ${baselines.continuityPackage.failed}.`);
  }
  return lines.join("\n");
}

function renderTableCounts(tables) {
  return Object.entries(tables)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join("\n");
}

// يملأ القالب من الحالة المجمعة ويرفض أي عنصر نائب لم يُملأ.
export function renderResumeHere(template, { state, mainCommit, gitStatusSummary, schemaVersion, tables, createdAt }) {
  assertTemplateHasNoHardcodedState(template);
  const values = {
    PROJECT_NAME: state.projectName,
    BUNDLE_CREATED_AT: createdAt,
    MAIN_COMMIT: mainCommit,
    GIT_STATUS_SUMMARY: gitStatusSummary,
    LAST_APPROVED_FUNCTIONAL_PHASE: state.lastApprovedFunctionalPhase,
    CONTINUITY_PACKAGE_PHASE: state.continuityPackagePhase,
    CURRENT_TASK_AND_NEXT_STEP: `المرحلة التالية المخططة ${state.nextPlannedPhase} لم تبدأ؛ الخطوة التالية هي انتظار مهمة مكتوبة من المشرف (SUPERVISOR) بعد الاستعادة والتحقق.`,
    SCHEMA_VERSION: String(schemaVersion),
    TABLE_COUNTS: renderTableCounts(tables),
    TEST_BASELINES: renderTestBaselines(state),
    STOPPED_GATES: renderStoppedGates(state),
    PENDING_HUMAN_GATES: (state.pendingHumanGates || []).map((gate) => `- ${gate}`).join("\n"),
  };
  const rendered = template.replace(TOKEN_PATTERN, (token) => {
    const key = token.slice(2, -2);
    if (!(key in values)) {
      throw new RecoveryResumeError(`عنصر نائب غير معروف في قالب RESUME_HERE: ${token}`, { stage: "resume-render" });
    }
    return values[key];
  });
  const leftover = rendered.match(TOKEN_PATTERN);
  if (leftover) {
    throw new RecoveryResumeError(`عناصر نائبة لم تُملأ في RESUME_HERE: ${leftover.join(", ")}`, { stage: "resume-render" });
  }
  return rendered;
}
