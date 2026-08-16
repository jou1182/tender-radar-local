// اختبارات P4-A1C0: فرض JSON Schema المحلي على مخرجات Ollama عبر حقل format،
// مع إبقاء validateAnalysisReport حاجزًا إلزاميًا ثانيًا. محاكاة محلية فقط:
// بلا Ollama حي، بلا شبكة، بلا Chrome أو اعتماد.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import {
  analysisFindingFields,
  analysisPromptVersion,
  analysisReportFields,
  analysisReportJsonSchema,
  analysisReportSchemaVersion,
  emptyAnalysisReport,
  validateAnalysisReport,
} from "../scripts/lib/analysis-report.mjs";
import { createOllamaProvider } from "../scripts/lib/analysis-providers.mjs";
import { buildEvidenceCandidateCatalog } from "../scripts/lib/analysis-evidence-candidates.mjs";
import { buildModelSelectionPrompt, buildModelSelectionSchema } from "../scripts/lib/analysis-model-selection.mjs";

// حاجز الاتصال: أي محاولة fetch حقيقية تسقط الاختبار فورًا.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("REAL_NETWORK_FORBIDDEN: استخدم fetchFn وهميًا"); };
after(() => { globalThis.fetch = realFetch; });

const ollamaEnv = { RADAR_AI_ENABLED: "true", RADAR_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://127.0.0.1:11434" };
// P4-A1D0: المستند يحتاج كتلة فعلية ليُبنى كتالوج المرشحين قبل استدعاء النموذج.
const fakeDocument = {
  documentId: "doc-p4a1c0",
  documentType: "pdf",
  warnings: [],
  blocks: [{ blockId: "b1", kind: "page-text", text: "نص جزء اختبار ثابت.", source: { pageNumber: 1 } }],
};
const fakeChunks = [{ chunkId: "chk-1", text: "نص جزء اختبار ثابت.", blockIds: ["b1"], sources: [{ pageNumber: 1 }] }];

// اختيار نموذج صحيح الشكل (P4-M0BR0 / analysis-model-selection-v2):
// الفئات الاثنتا عشرة + القرار واليقين وأدلة القرار فقط — بلا executiveSummary
// ولا warnings ولا evidence (المخطط الداخلي لا يقبل أي حقل نصي أو زائد).
function emptySelection() {
  const selection = { ...emptyAnalysisReport() };
  delete selection.evidence;
  delete selection.executiveSummary;
  delete selection.warnings;
  return selection;
}

// يحل مرجعًا محليًا من الشكل #/$defs/name داخل الجذر المعطى.
function resolveRef(root, node) {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const name = node.$ref.replace("#/$defs/", "");
    return root.$defs[name];
  }
  return node;
}

test("A) الشكل العام للمخطط", () => {
  assert.equal(analysisReportJsonSchema.type, "object");
  assert.equal(analysisReportJsonSchema.additionalProperties, false, "لا حقول زائدة مثل documentId/documentType/version");
  assert.equal(analysisReportJsonSchema.required.length, 18, "الحقول الثمانية عشر كلها مطلوبة");
  for (const field of analysisReportFields) {
    assert.ok(analysisReportJsonSchema.required.includes(field), `required يتضمن ${field}`);
    assert.ok(field in analysisReportJsonSchema.properties, `properties تتضمن ${field}`);
  }
  assert.deepEqual(Object.keys(analysisReportJsonSchema.properties).sort(), [...analysisReportFields].sort(), "لا حقول زائدة في properties");
  // قابلية التسلسل الكاملة: بلا functions وبلا undefined.
  const roundTrip = JSON.parse(JSON.stringify(analysisReportJsonSchema));
  assert.deepEqual(roundTrip, analysisReportJsonSchema, "JSON.stringify/JSON.parse ينجحان ويحافظان على البنية");
});

test("B) الفئات الاثنتا عشرة مصفوفات findings في المخطط", () => {
  assert.equal(analysisFindingFields.length, 12);
  for (const field of analysisFindingFields) {
    const node = analysisReportJsonSchema.properties[field];
    assert.ok(node, `${field} موجود في properties`);
    assert.notEqual(node.type, "object", `${field} لا يُعرّف كـobject`);
    const list = resolveRef(analysisReportJsonSchema, node);
    assert.equal(list.type, "array", `${field} مصفوفة`);
    const item = resolveRef(analysisReportJsonSchema, list.items);
    assert.equal(item, analysisReportJsonSchema.$defs.finding, `${field} عناصره finding schema`);
    // المصفوفة الفارغة مسموحة: لا minItems على مستوى الفئة.
    assert.ok(!("minItems" in list), `${field} يسمح بالمصفوفة الفارغة`);
  }
});

test("C) مخطط finding", () => {
  const finding = analysisReportJsonSchema.$defs.finding;
  assert.equal(finding.type, "object");
  assert.equal(finding.additionalProperties, false);
  assert.deepEqual([...finding.required].sort(), ["category", "confidence", "evidenceIds", "severity", "statement"]);
  assert.equal(finding.properties.category.type, "string");
  assert.equal(finding.properties.category.minLength, 1);
  assert.equal(finding.properties.statement.type, "string");
  assert.equal(finding.properties.statement.minLength, 1);
  assert.deepEqual(finding.properties.severity.enum, ["info", "low", "medium", "high", "critical"]);
  assert.deepEqual(finding.properties.confidence.enum, ["low", "medium", "high"]);
  assert.equal(finding.properties.evidenceIds.type, "array");
  assert.equal(finding.properties.evidenceIds.minItems, 1, "evidenceIds غير فارغة");
  assert.equal(finding.properties.evidenceIds.items.type, "string");
  assert.equal(finding.properties.evidenceIds.items.minLength, 1);
});

test("D) مخطط evidence", () => {
  const evidence = analysisReportJsonSchema.$defs.evidence;
  assert.equal(evidence.type, "object");
  assert.equal(evidence.additionalProperties, false);
  for (const key of ["evidenceId", "documentId", "sourceType", "excerpt", "chunkId"]) {
    assert.ok(evidence.required.includes(key), `${key} مطلوب`);
  }
  assert.deepEqual(evidence.properties.sourceType.enum, ["pdf", "xlsx", "docx"]);
  assert.equal(evidence.properties.excerpt.type, "string");
  assert.equal(evidence.properties.excerpt.maxLength, 400);
  assert.equal(evidence.properties.excerpt.minLength, 1);
  assert.equal(evidence.properties.pageNumber.type, "integer");
  assert.equal(evidence.properties.pageNumber.minimum, 1);
  // موقع واحد صالح على الأقل: صفحة، أو ورقة+نطاق، أو قسم.
  assert.ok(Array.isArray(evidence.anyOf) && evidence.anyOf.length === 3, "anyOf يفرض الموقع");
  assert.deepEqual(evidence.anyOf[0].required, ["pageNumber"], "PDF برقم صفحة");
  assert.deepEqual(evidence.anyOf[1].required, ["sheetName", "cellRange"], "XLSX بورقة ونطاق معًا");
  assert.deepEqual(evidence.anyOf[2].required, ["section"], "DOCX بقسم");
  // تمثيل الأنواع الثلاثة ممكن: خصائص الموقع الثلاثة معرفة.
  for (const key of ["pageNumber", "sheetName", "cellRange", "section"]) {
    assert.ok(key in evidence.properties, `${key} قابل للتمثيل`);
  }
});

test("E) حقول القرار والملخص", () => {
  const { properties } = analysisReportJsonSchema;
  assert.deepEqual(properties.preliminaryDecision.enum, ["enter", "review", "exclude", "insufficient_data"]);
  assert.deepEqual(properties.confidence.enum, ["low", "medium", "high"]);
  assert.equal(properties.decisionEvidenceIds.type, "array");
  assert.equal(properties.decisionEvidenceIds.items.type, "string");
  assert.equal(properties.decisionEvidenceIds.items.minLength, 1);
  assert.ok(!("minItems" in properties.decisionEvidenceIds), "الفراغ مسموح — المدقق يفرض عدمه عند القرارات فقط");
  assert.equal(properties.warnings.type, "array");
  assert.equal(properties.warnings.items.type, "string");
  assert.equal(properties.executiveSummary.type, "string");
  assert.equal(properties.executiveSummary.minLength, 1);
});

test("F) المخطط مجمد بالكامل ولا يتغير بمحاولة التعديل", () => {
  assert.ok(Object.isFrozen(analysisReportJsonSchema), "الجذر مجمد");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.properties), "properties مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs), "$defs مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs.finding), "finding مجمد");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs.finding.properties), "خصائص finding مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs.evidence), "evidence مجمد");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs.evidence.anyOf), "anyOf مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.required), "required مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.properties.scopeOfWork), "عقد الفئات مجمدة");
  assert.ok(Object.isFrozen(analysisReportJsonSchema.$defs.finding.properties.severity.enum), "enum مجمدة");
  assert.throws(() => { analysisReportJsonSchema.additionalProperties = true; }, TypeError, "التعديل مرفوض في الوضع الصارم");
  assert.equal(analysisReportJsonSchema.additionalProperties, false, "المحاولة لم تغيّر القيمة");
  assert.throws(() => { analysisReportJsonSchema.properties.injected = {}; }, TypeError);
  assert.ok(!("injected" in analysisReportJsonSchema.properties), "لا حقن خصائص");
});

test("G) جسم طلب Ollama: format مخطط اختيار ديناميكي وليس نصًا", async () => {
  const catalogForResponse = buildEvidenceCandidateCatalog({ document: fakeDocument, chunks: fakeChunks });
  const candidateId = catalogForResponse.candidates[0].candidateId;
  let seenBody = null;
  const seenUrls = [];
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url, options) => {
      seenUrls.push(url);
      seenBody = JSON.parse(options.body);
      const response = {
        ...emptySelection(),
        scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [candidateId] }],
        preliminaryDecision: "review",
        confidence: "medium",
        decisionEvidenceIds: [candidateId],
      };
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(response) }) };
    },
  });
  await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  assert.deepEqual(seenUrls, ["http://127.0.0.1:11434/api/generate"], "endpoint الوحيد /api/generate ولا /api/pull");
  assert.equal(typeof seenBody.format, "object", "format ليس string");
  assert.notEqual(seenBody.format, "json", "لم تعد القيمة النصية json");
  // P4-M0BR0: format يحمل مخطط الاختيار الداخلي v2 الديناميكي المعتمد على كتالوج المستند.
  const catalog = buildEvidenceCandidateCatalog({ document: fakeDocument, chunks: fakeChunks });
  assert.deepEqual(seenBody.format, JSON.parse(JSON.stringify(buildModelSelectionSchema(catalog.candidates))), "format يطابق مخطط الاختيار الديناميكي بنيويًا");
  assert.ok(!("evidence" in seenBody.format.properties), "النموذج لا يرى حقل evidence إطلاقًا");
  assert.ok(!("executiveSummary" in seenBody.format.properties), "النموذج لا يرى حقل executiveSummary إطلاقًا");
  assert.ok(!("warnings" in seenBody.format.properties), "النموذج لا يرى حقل warnings إطلاقًا");
  assert.equal(seenBody.stream, false);
  assert.equal(seenBody.options.temperature, 0);
  assert.equal(seenBody.model, "qwen2.5:7b", "النموذج الافتراضي من الإعداد");
  // P4-M0B2A: think:false يُرسل كقيمة boolean صريحة داخل /api/generate.
  assert.equal(seenBody.think, false, "think:false في جسم طلب /api/generate");
  assert.equal(typeof seenBody.think, "boolean", "think قيمة boolean لا string ولا undefined");
  assert.match(seenBody.prompt, /analysis-model-selection-v2/, "مخطط الاختيار الداخلي v2 مذكور في الـprompt");
});

test("H) استجابة صحيحة مطابقة تنجح وتبقى صيغة التقرير v2", async () => {
  const catalog = buildEvidenceCandidateCatalog({ document: fakeDocument, chunks: fakeChunks });
  const candidateId = catalog.candidates[0].candidateId;
  const validSelection = {
    ...emptySelection(),
    scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [candidateId] }],
    preliminaryDecision: "review",
    confidence: "medium",
    decisionEvidenceIds: [candidateId],
  };
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ response: JSON.stringify(validSelection) }) }),
  });
  const result = await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  const { _meta, ...report } = result;
  assert.deepEqual(validateAnalysisReport(report), [], "التقرير canonical المعاد بناؤه يجتاز المدقق الحاجز الثاني");
  assert.equal(report.evidence.length, 1, "evidence بُنيت محليًا من الكتالوج");
  assert.equal(report.evidence[0].excerpt, "نص جزء اختبار ثابت.", "excerpt حرفي من الكتالوج لا من النموذج");
  assert.ok(Number.isInteger(_meta.durationMs));
  assert.equal(analysisReportSchemaVersion, "analysis-report-v2");
  assert.equal(analysisPromptVersion, "p4a-prompt-v4");
});

test("I) استجابة مشوهة (شكل P4-A1B) تُرفض بـAI_OUTPUT_INVALID بلا TypeError وبلا إعادة", async () => {
  const malformed = { ...emptySelection(), scopeOfWork: { category: "scopeOfWork", statement: "كائن لا مصفوفة" } };
  let generateCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url) => {
      generateCalls += 1;
      assert.ok(url.endsWith("/api/generate"));
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(malformed) }) };
    },
  });
  const error = await provider.analyze({ document: fakeDocument, chunks: fakeChunks }).then(() => null, (caught) => caught);
  assert.ok(error, "analyze يرفض المخرجات المشوهة");
  assert.equal(error.code, "AI_OUTPUT_INVALID");
  assert.ok(!(error instanceof TypeError), "لا TypeError");
  assert.match(error.message, /scopeOfWork/);
  assert.equal(generateCalls, 1, "لا إعادة محاولة إطلاقًا");
});

// ---------- P4-M0B2A: think:false مع بقاء قناة response الرسمية حصريًا ----------
function validSelectionFor() {
  const catalog = buildEvidenceCandidateCatalog({ document: fakeDocument, chunks: fakeChunks });
  const candidateId = catalog.candidates[0].candidateId;
  return {
    selection: {
      ...emptySelection(),
      scopeOfWork: [{ severity: "info", confidence: "medium", evidenceIds: [candidateId] }],
      preliminaryDecision: "review",
      confidence: "medium",
      decisionEvidenceIds: [candidateId],
    },
    candidateId,
    catalog,
  };
}

test("J) P4-M0B2A: think:false boolean في جسم /api/generate مع بقاء format كائن JSON Schema المعتمد", async () => {
  let seenBody = null;
  const { selection } = validSelectionFor();
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url, options) => {
      seenBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection) }) };
    },
  });
  await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  assert.equal(seenBody.think, false, "think:false كقيمة boolean");
  assert.equal(typeof seenBody.think, "boolean", "think من النوع boolean لا string");
  const { catalog } = validSelectionFor();
  assert.equal(typeof seenBody.format, "object", "format يبقى كائن JSON Schema object");
  assert.notEqual(seenBody.format, "json", "format ليس النص json");
  assert.deepEqual(seenBody.format, JSON.parse(JSON.stringify(buildModelSelectionSchema(catalog.candidates))), "format يطابق مخطط الاختيار الديناميكي المعتمد بنيويًا");
});

test("K) P4-M0B2A: response صالح + thinking فارغ → نجاح طبيعي", async () => {
  const { selection } = validSelectionFor();
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection), thinking: "" }) }),
  });
  const result = await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  const { _meta, ...report } = result;
  assert.deepEqual(validateAnalysisReport(report), [], "التقرير صالح");
  assert.equal(report.evidence.length, 1, "evidence بُنيت من الكتالوج");
  assert.ok(Number.isInteger(_meta.durationMs), "المدة مسجلة في الميتا");
});

test("L) P4-M0B2A: response صالح + thinking نص/JSON مختلف → يعتمد response فقط", async () => {
  const { selection, candidateId } = validSelectionFor();
  const thinkingGarbage = "تفكير عشوائي {\"scopeOfWork\": []} لا يخص المخطط";
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection), thinking: thinkingGarbage }) }),
  });
  const result = await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  const { _meta, ...report } = result;
  assert.deepEqual(validateAnalysisReport(report), []);
  assert.equal(report.scopeOfWork[0].evidenceIds[0], candidateId, "التقرير مبني من response الرسمي فقط");
  assert.ok(!JSON.stringify(report).includes(thinkingGarbage), "thinking لا يدخل التقرير المخزن");
  assert.ok(_meta.evidenceCandidates.sent >= 1, "إحصاء الكتالوج مسجل في الميتا");
});

test("M) P4-M0B2A: response فارغ + thinking JSON صالح → AI_OUTPUT_INVALID بلا fallback من thinking", async () => {
  const { selection } = validSelectionFor();
  let generateCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url) => {
      generateCalls += 1;
      assert.ok(url.endsWith("/api/generate"));
      return { ok: true, status: 200, json: async () => ({ response: "", thinking: JSON.stringify(selection) }) };
    },
  });
  const error = await provider.analyze({ document: fakeDocument, chunks: fakeChunks }).then(() => null, (caught) => caught);
  assert.ok(error, "يجب أن يفشل آمنًا");
  assert.equal(error.code, "AI_OUTPUT_INVALID", "لا fallback يقرأ thinking");
  assert.ok(!(error instanceof TypeError), "لا TypeError");
  assert.ok(!String(error.message).includes("scopeOfWork"), "الخطأ لا يتسرب إليه محتوى thinking");
  assert.equal(generateCalls, 1, "محاولة واحدة بلا retry");
});

test("N) P4-M0B2A: response مشوه (JSON نصي غير صالح) → AI_OUTPUT_INVALID لا TypeError", async () => {
  let generateCalls = 0;
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => {
      generateCalls += 1;
      return { ok: true, status: 200, json: async () => ({ response: "not-json{{{", thinking: "أي نص" }) };
    },
  });
  const error = await provider.analyze({ document: fakeDocument, chunks: fakeChunks }).then(() => null, (caught) => caught);
  assert.ok(error, "يجب أن يرفض");
  assert.equal(error.code, "AI_OUTPUT_INVALID");
  assert.ok(!(error instanceof TypeError), "لا TypeError");
  assert.equal(generateCalls, 1, "لا retry");
});

test("O) P4-M0B2A: thinking لا يظهر في التقرير المخزن ولا الميتا ولا رسالة الخطأ", async () => {
  const { selection } = validSelectionFor();
  const secretThinking = "محتوى تفكير سري لا يجب تخزينه";
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ response: JSON.stringify(selection), thinking: secretThinking }) }),
  });
  const result = await provider.analyze({ document: fakeDocument, chunks: fakeChunks });
  assert.ok(!JSON.stringify(result).includes(secretThinking), "thinking غير موجود في النتيجة/الميتا");
  const provider2 = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ response: "", thinking: JSON.stringify(selection) }) }),
  });
  const error = await provider2.analyze({ document: fakeDocument, chunks: fakeChunks }).then(() => null, (caught) => caught);
  const message = String((error && error.message) || "");
  assert.ok(!message.includes("scopeOfWork"), "رسالة الخطأ لا تحوي محتوى thinking");
  assert.ok(!message.includes("thinking"), "رسالة الخطأ لا تشير إلى حقل thinking إطلاقًا");
});

test("P) P4-M0B2A: لا retry ولا /api/pull — endpoint واحد /api/generate فقط", async () => {
  const urls = [];
  const provider = createOllamaProvider({
    env: ollamaEnv,
    fetchFn: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ response: "bad{{{", thinking: "" }) };
    },
  });
  await provider.analyze({ document: fakeDocument, chunks: fakeChunks }).then(() => null, () => null);
  assert.deepEqual(urls, ["http://127.0.0.1:11434/api/generate"], "endpoint الوحيد /api/generate");
  assert.equal(urls.length, 1, "محاولة واحدة بلا retry ولا pull");
});

test("Q) P4-M0B2A: runtime-freeze محدَّث وبصمة analysis-providers تطابق الملف الفعلي (ثبات الـfreeze)", () => {
  const freeze = JSON.parse(readFileSync(new URL("../benchmark/runtime-freeze.json", import.meta.url), "utf8"));
  const actual = createHash("sha256").update(readFileSync(new URL("../scripts/lib/analysis-providers.mjs", import.meta.url))).digest("hex");
  assert.equal(actual, freeze.files["scripts/lib/analysis-providers.mjs"], "بصمة providers في runtime-freeze تطابق الملف بعد think:false");
});

test("R) P4-M0B4: التعليمات الجديدة ضد التنويهات والتعارضات موجودة حرفيًا في الـprompt الناتج", () => {
  const catalog = buildEvidenceCandidateCatalog({ document: fakeDocument, chunks: fakeChunks });
  assert.ok(catalog.candidates.length > 0, "كتالوج مرشحين متاح لبناء الـprompt");
  const prompt = buildModelSelectionPrompt({ document: fakeDocument, catalog });
  assert.ok(
    prompt.includes("أي مقتطف يبدو تنويهًا أو علامة تحذيرية تفيد أن الوثيقة بيانات اختبار اصطناعية أو ليست منافسة حقيقية — يُستبعد تمامًا من أي finding واقعي؛ لا يُعامل كشرط أهلية أو حقيقة من الوثيقة."),
    "تعليمة استبعاد التنويهات موجودة حرفيًا",
  );
  assert.ok(
    prompt.includes("إن وُجدت قيمتان متعارضتان صراحةً لنفس الحقيقة (نفس البند، مدة أو تاريخ أو مبلغ مختلف) بين مقتطفات مختلفة — يُمنع اختيار أحدهما وحسم التعارض؛ يجب توجيه هذه الحالة إلى unclearItems أو questionsForAuthority فقط."),
    "تعليمة التعارضات موجودة حرفيًا",
  );
});

test("S) P4-M0B4: runtime-freeze محدَّث وبصمة analysis-model-selection تطابق الملف الفعلي", () => {
  const freeze = JSON.parse(readFileSync(new URL("../benchmark/runtime-freeze.json", import.meta.url), "utf8"));
  const actual = createHash("sha256").update(readFileSync(new URL("../scripts/lib/analysis-model-selection.mjs", import.meta.url))).digest("hex");
  assert.equal(actual, freeze.files["scripts/lib/analysis-model-selection.mjs"], "بصمة model-selection في runtime-freeze تطابق الملف بعد إضافة تعليمات P4-M0B4");
});
