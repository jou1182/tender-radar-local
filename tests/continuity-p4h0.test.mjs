// اختبارات P4-H0: حزمة الاستمرارية المحايدة للوكلاء.
// تحقق حتمي محلي فقط: وجود الملفات، صحة CURRENT_STATE.json، غياب الأسرار
// والمسارات المطلقة، سلامة الروابط النسبية، والمحايدة من أي وكيل بعينه.
// بلا شبكة ولا fetch ولا خدمات — قراءة ملفات نصية فقط.
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

const packageFiles = [
  "AGENTS.md",
  "docs/continuity/PROJECT_HANDOFF.md",
  "docs/continuity/CURRENT_STATE.json",
  "docs/continuity/PHASE_LEDGER.md",
  "docs/continuity/ARCHITECTURE.md",
  "docs/continuity/SAFETY_BOUNDARIES.md",
  "docs/continuity/OPERATIONS_RUNBOOK.md",
  "docs/continuity/TASK_TEMPLATE.md",
  "docs/continuity/REVIEW_CHECKLIST.md",
  "docs/continuity/NEXT_PHASES.md",
];

function readPackageFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("1) جميع ملفات الحزمة موجودة وغير فارغة", () => {
  for (const file of packageFiles) {
    const absolute = path.join(root, file);
    assert.ok(existsSync(absolute), `${file} موجود`);
    assert.ok(statSync(absolute).size > 200, `${file} غير فارغ ويحمل محتوى فعليًا`);
  }
});

test("2) CURRENT_STATE.json صالح وبنيته neutral-continuity-state-v1", () => {
  const state = JSON.parse(readPackageFile("docs/continuity/CURRENT_STATE.json"));
  assert.equal(state.stateSchemaVersion, "neutral-continuity-state-v1");
  assert.equal(state.projectName, "tender-radar-local");
});

test("3) القيم الأساسية في CURRENT_STATE.json صحيحة", () => {
  const state = JSON.parse(readPackageFile("docs/continuity/CURRENT_STATE.json"));
  assert.equal(state.approvedBaselineCommit, "5428aeec839311cb1ada8bd2157b4d366a309267", "commit الأساس المعتمد");
  assert.equal(state.lastApprovedPhase, "P4-A1D0M");
  assert.equal(state.databaseSchemaVersion, 7, "schemaVersion 7");
  assert.equal(state.approvedTestBaseline.passed, 143, "143 اختبارًا ناجحًا عند الأساس");
  assert.equal(state.approvedTestBaseline.failed, 0, "صفر فاشل");
  assert.equal(state.analysisReportSchemaVersion, "analysis-report-v2");
  assert.equal(state.analysisPromptVersion, "p4a-prompt-v3");
  assert.equal(state.modelSelectionSchemaVersion, "analysis-model-selection-v1");
  assert.equal(state.liveAiEnabledByDefault, false, "الذكاء الحي معطل افتراضيًا");
  assert.equal(state.currentDefaultProvider, "stub");
  assert.equal(state.nextPlannedPhase, "P4-M0");
  assert.ok(Array.isArray(state.pendingHumanGates) && state.pendingHumanGates.length > 0);
  assert.ok(Array.isArray(state.knownRisks) && state.knownRisks.length > 0);
  assert.ok(Array.isArray(state.authoritativeDocuments) && state.authoritativeDocuments.length === 10);
});

test("4) تسجيل النموذجين: qwen2.5:14b معروف وNemotron بحالة installed_tag_unverified فقط", () => {
  const state = JSON.parse(readPackageFile("docs/continuity/CURRENT_STATE.json"));
  assert.equal(state.localModels.qwen.knownInstalledTag, "qwen2.5:14b");
  assert.equal(state.localModels.nemotron.status, "installed_tag_unverified");
  assert.match(state.localModels.nemotron.note, /\/api\/tags/, "الاسم الدقيق يُكتشف من /api/tags لاحقًا");
  const nextPhases = readPackageFile("docs/continuity/NEXT_PHASES.md");
  assert.doesNotMatch(nextPhases, /nemotron[:\w.-]*\d/i, "لا اسم Nemotron تخمينيًا برقم أو وسم");
  assert.match(nextPhases, /installed_tag_unverified/, "NEXT_PHASES يسجل حالة عدم التحقق نفسها");
});

test("5) لا مسارات Windows مطلقة ولا أسماء مستخدمين في أي ملف من الحزمة", () => {
  for (const file of packageFiles) {
    const content = readPackageFile(file);
    assert.doesNotMatch(content, /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]/i, `${file}: مسار مستخدم مطلق`);
    assert.doesNotMatch(content, /C:\\Users\\/i, `${file}: لا C:\\Users`);
  }
});

test("6) لا أسرار فعلية: مفاتيح API وBearer وJWT وcookies وكلمات مرور معيّنة ومفاتيح خاصة", () => {
  // الكلمات التوثيقية (password/cookie…) مسموحة ضمن قواعد المنع؛ الممنوع هو القيم الفعلية.
  const secretPatterns = [
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT فعلي"],
    [/Bearer\s+[A-Za-z0-9._~-]{12,}/i, "Bearer token فعلي"],
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "مفتاح خاص"],
    [/Cookie:\s*[\w-]+=[^\s;]{3,}/i, "Cookie فعلية بقيمة"],
    [/(?:password|passwd|api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'`]?[^\s"'`]{3,}/i, "تعيين سر بقيمة"],
    [/\b(?:sk|pk|xox[baprs])-[A-Za-z0-9-]{16,}\b/, "مفتاح API بصيغة مزود معروفة"],
  ];
  for (const file of packageFiles) {
    const content = readPackageFile(file);
    for (const [pattern, label] of secretPatterns) {
      assert.doesNotMatch(content, pattern, `${file}: ${label}`);
    }
  }
});

test("7) جميع الروابط النسبية في ملفات الحزمة تشير إلى ملفات موجودة", () => {
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let linkCount = 0;
  for (const file of packageFiles.filter((name) => name.endsWith(".md"))) {
    const content = readPackageFile(file);
    for (const match of content.matchAll(linkPattern)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue; // خارجي أو مرساة
      const resolved = path.resolve(path.dirname(path.join(root, file)), target);
      assert.ok(existsSync(resolved), `${file}: الرابط ${target} يشير إلى ملف موجود`);
      linkCount += 1;
    }
  }
  assert.ok(linkCount >= 12, `روابط الحزمة فُحصت فعليًا (${linkCount})`);
});

test("8) AGENTS.md نقطة الدخول ويشير إلى ملفات docs/continuity", () => {
  const agents = readPackageFile("AGENTS.md");
  assert.match(agents, /docs\/continuity\/PROJECT_HANDOFF\.md/, "يشير إلى PROJECT_HANDOFF.md");
  assert.match(agents, /docs\/continuity\/SAFETY_BOUNDARIES\.md/, "يشير إلى SAFETY_BOUNDARIES.md");
  assert.match(agents, /مصدر الحقيقة/, "يؤكد أن Git وSQLite والاختبارات مصدر الحقيقة");
  assert.match(agents, /الأدوار أهم من اسم الوكيل|الأدوار والقواعد أهم/, "الأدوار أهم من الأسماء");
});

test("9) ملفات السلامة تتضمن القيود الأساسية غير القابلة للتفاوض", () => {
  const safety = readPackageFile("docs/continuity/SAFETY_BOUNDARIES.md");
  for (const expected of [
    "لا شراء",
    "CAPTCHA",
    "صفحة التفاصيل الموثوقة فقط",
    "loopback",
    "grounding",
    "يختار معرفات أدلة فقط",
    "التوقف الآمن",
    "RADAR_LIVE_DOWNLOAD_ENABLED=false",
    "لا تخزين ولا طلب لبيانات الدخول",
    "نشاط مصطنع",
  ]) {
    assert.ok(safety.includes(expected), `SAFETY_BOUNDARIES.md يتضمن: ${expected}`);
  }
  const agents = readPackageFile("AGENTS.md");
  for (const expected of ["fast-forward only", "لا يعتمد عمله بنفسه", "commit واحد وتقرير واحد"]) {
    assert.ok(agents.includes(expected), `AGENTS.md يتضمن: ${expected}`);
  }
});

test("10) لا اعتماد إلزامي على أي وكيل بعينه (Codex/Kimi/Claude/Gemini)", () => {
  for (const file of packageFiles) {
    const content = readPackageFile(file);
    assert.doesNotMatch(
      content,
      /(يجب|يلزم|إلزاميًا|حصريًا)[^.\n]{0,60}(Codex|Kimi|Claude|Gemini)/,
      `${file}: لا اعتماد إلزامي على وكيل مسمى`,
    );
    assert.doesNotMatch(
      content,
      /(Codex|Kimi|Claude|Gemini)[^.\n]{0,40}(إلزامي|حصري|لا غنى عنه)/,
      `${file}: لا حصرية لأي وكيل`,
    );
  }
});

test("11) الوثائق تسجل القيود الحاكمة: fixtures فقط وP3-B1C متوقفة والمجانية من التفاصيل", () => {
  const handoff = readPackageFile("docs/continuity/PROJECT_HANDOFF.md");
  assert.match(handoff, /fixtures فقط/, "التحليل مجرّب على fixtures فقط");
  assert.match(handoff, /P3‑B1C.*متوقفة|متوقفة.*P3‑B1C/, "P3-B1C متوقفة");
  assert.match(handoff, /المجانية لا تُثبت إلا من صفحة التفاصيل/, "المجانية من صفحة التفاصيل فقط");
  const next = readPackageFile("docs/continuity/NEXT_PHASES.md");
  assert.match(next, /48 مرشحًا/, "خطر قص أول 48 مرشحًا موثق");
  assert.match(next, /تحيز الصفحات الأولى/, "تحيز الصفحات الأولى موثق");
  assert.match(next, /ممنوع في P4‑H0|لا تعديل لخوارزمية الكتالوج/, "منع تعديل الخوارزمية في P4-H0 موثق");
});

test("12) السجل يوثق المراحل وحالاتها دون نسخ تقارير كاملة", () => {
  const ledger = readPackageFile("docs/continuity/PHASE_LEDGER.md");
  for (const phase of ["P0", "P1", "P2", "P3-A", "P3-B0", "P3-B1A", "P3-B1B0", "P4-A0", "P4-A1R", "P4-A1C0", "P4-A1D0"]) {
    assert.ok(ledger.includes(phase), `السجل يذكر ${phase}`);
  }
  assert.match(ledger, /5428aee/, "commit P4-A1D0 موثق");
  assert.match(ledger, /fast-forward/, "سياسة الدمج موثقة");
  assert.match(ledger, /paused/, "حالة التوقف مستخدمة");
});
