// مزودو تحليل الذكاء الاصطناعي المحلي — P4-A0.
// StubProvider هو الافتراضي الوحيد العامل دون تفعيل. OllamaProvider لا يعمل إلا
// بتفعيل صريح (RADAR_AI_ENABLED=true) ومضيف loopback حصرًا، وبلا سحب نماذج إطلاقًا،
// وبمهلة واضحة وبلا إعادة محاولة، ويفشل بأمان دون تسجيل نصوص حساسة.
import {
  analysisPromptVersion,
  analysisReportSchemaVersion,
  emptyAnalysisReport,
} from "./analysis-report.mjs";
import { buildEvidenceCandidateCatalog } from "./analysis-evidence-candidates.mjs";
import {
  buildModelSelectionPrompt,
  buildModelSelectionSchema,
  materializeCanonicalReport,
} from "./analysis-model-selection.mjs";

export const analysisProviderNames = ["stub", "ollama"];

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// loopback فقط: 127.0.0.1 أو localhost أو ::1 عبر HTTP. أي مضيف آخر مرفوض افتراضيًا.
export function assertLoopbackOllamaHost(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw providerError("AI_UNTRUSTED_HOST", "عنوان Ollama غير صالح؛ يُقبل مضيف محلي loopback فقط.");
  }
  const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (!loopback) {
    throw providerError("AI_UNTRUSTED_HOST", `مضيف Ollama مرفوض (${parsed.hostname || "غير معروف"})؛ يُقبل 127.0.0.1 أو localhost فقط.`);
  }
  return parsed.origin;
}

export function readAnalysisAiConfig(env = {}) {
  return {
    enabled: env.RADAR_AI_ENABLED === "true",
    provider: analysisProviderNames.includes(env.RADAR_AI_PROVIDER) ? env.RADAR_AI_PROVIDER : "stub",
    ollamaHost: env.OLLAMA_HOST || "http://127.0.0.1:11434",
    ollamaModel: env.OLLAMA_MODEL || "nemotron-3.5-lightning:latest",
    timeoutMs: Number(env.RADAR_AI_TIMEOUT_MS) > 0 ? Number(env.RADAR_AI_TIMEOUT_MS) : 60_000,
  };
}

// ---------- StubProvider: تحليل حتمي بالقواعد فوق النص المستخرج، بلا أي اتصال ----------
const categoryPatterns = [
  { field: "bidBonds", pattern: /الضمان الابتدائي[:：]?\s*([^\n.]+)/, label: "الضمان الابتدائي" },
  { field: "guarantees", pattern: /الضمان النهائي[:：]?\s*([^\n.]+)/, label: "الضمان النهائي" },
  { field: "penalties", pattern: /غرامة[^:\n]*[:：]?\s*([^\n.]+)/, label: "الغرامات" },
  { field: "deadlines", pattern: /(?:آخر موعد|مدة العقد|الموعد)[^\n:]*[:：]?\s*([^\n.]+)/, label: "المواعيد" },
  { field: "eligibilityRequirements", pattern: /شروط الأهلية[:：]?\s*([^\n.]+)/, label: "شروط الأهلية" },
  { field: "requiredExperience", pattern: /الخبرة المطلوبة[:：]?\s*([^\n.]+)/, label: "الخبرة المطلوبة" },
  { field: "scopeOfWork", pattern: /نطاق العمل[:：]?\s*([^\n.]+)/, label: "نطاق العمل" },
];

function findChunkForBlock(chunks, blockId) {
  // يطابق أيضًا أجزاء الكتل المقسمة (#p1/#p2…) الناتجة عن حد maxChars الصارم.
  return chunks.find((chunk) => chunk.blockIds.some((id) => id === blockId || id.startsWith(`${blockId}#`)));
}

export function createStubProvider() {
  return {
    name: "stub",
    model: null,
    // تحليل حتمي: نفس المستند يعطي نفس التقرير ونفس الأدلة في كل تشغيل.
    async analyze({ document, chunks }) {
      const report = emptyAnalysisReport({ warnings: [...document.warnings] });
      const evidence = [];
      const addEvidence = (block) => {
        const chunk = findChunkForBlock(chunks, block.blockId);
        if (!chunk) return null;
        const evidenceId = `ev-${evidence.length + 1}`;
        const source = block.source;
        evidence.push({
          evidenceId,
          documentId: document.documentId,
          sourceType: document.documentType,
          pageNumber: source.pageNumber,
          sheetName: source.sheetName,
          cellRange: source.cellRange,
          section: source.section,
          excerpt: block.text.slice(0, 200),
          chunkId: chunk.chunkId,
        });
        return evidenceId;
      };
      const addFinding = (field, block, match, severity = "info") => {
        const evidenceId = addEvidence(block);
        if (!evidenceId) return;
        const statement = `${categoryPatterns.find((item) => item.field === field)?.label || field}: ${match[1].trim()}`;
        // الفئات الاثنتا عشرة كلها findings موثقة بأدلة — لا نصوص حرة بلا دليل.
        report[field].push({
          category: field,
          statement,
          severity,
          confidence: "medium",
          evidenceIds: [evidenceId],
        });
      };

      for (const block of document.blocks) {
        for (const rule of categoryPatterns) {
          const match = block.text.match(rule.pattern);
          if (match) addFinding(rule.field, block, match);
        }
        const unclear = block.text.match(/غير واضح[:：]?\s*([^\n.]+)/);
        if (unclear) {
          const evidenceId = addEvidence(block);
          if (evidenceId) report.unclearItems.push({ category: "unclearItems", statement: `بند غير واضح: ${unclear[1].trim()}`, severity: "medium", confidence: "medium", evidenceIds: [evidenceId] });
        }
        const question = block.text.match(/سؤال للجهة[:：]?\s*([^\n؟?]+[؟?]?)/);
        if (question) {
          const evidenceId = addEvidence(block);
          if (evidenceId) report.questionsForAuthority.push({ category: "questionsForAuthority", statement: question[1].trim(), severity: "info", confidence: "medium", evidenceIds: [evidenceId] });
        }
        const risk = block.text.match(/غرامة تأخير|فسخ|إنهاء العقد/);
        if (risk) {
          const evidenceId = addEvidence(block);
          if (evidenceId) report.contractualRisks.push({ category: "contractualRisks", statement: block.text.slice(0, 160), severity: "medium", confidence: "medium", evidenceIds: [evidenceId] });
        }
      }

      for (const table of document.tables) {
        if (!table.rows.length) continue;
        const header = table.rows[0].join(" | ");
        const block = document.blocks.find((item) => item.tableId === table.tableId);
        const chunk = block ? findChunkForBlock(chunks, block.blockId) : null;
        const location = table.source.sheetName ? `الورقة ${table.source.sheetName}` : `القسم ${table.source.section}`;
        let tableEvidenceId = null;
        if (block && chunk) {
          // دليل الجدول يقتبس من كتلة فعلية داخل الجزء نفسه — لا نص مُركّب من خارجه.
          tableEvidenceId = `ev-${evidence.length + 1}`;
          evidence.push({
            evidenceId: tableEvidenceId,
            documentId: document.documentId,
            sourceType: document.documentType,
            pageNumber: block.source.pageNumber,
            sheetName: block.source.sheetName,
            cellRange: block.source.cellRange,
            section: block.source.section,
            excerpt: block.text.slice(0, 200),
            chunkId: chunk.chunkId,
          });
        }
        if (tableEvidenceId) {
          report.boqSummary.push({
            category: "boqSummary",
            statement: `جدول (${location}): ${table.rows.length} صفًا — الأعمدة: ${header}`,
            severity: "info",
            confidence: "medium",
            evidenceIds: [tableEvidenceId],
          });
          if (table.rows.length > 1 && /الكمية|القيمة/.test(header)) {
            report.criticalQuantities.push({
              category: "criticalQuantities",
              statement: `${location}: ${table.rows.slice(1).map((row) => row.join(" = ")).join("؛ ").slice(0, 300)}`,
              severity: "info",
              confidence: "medium",
              evidenceIds: [tableEvidenceId],
            });
          }
        }
      }

      const titleBlock = document.blocks.find((block) => /منافسة|كراسة/.test(block.text));
      report.executiveSummary = titleBlock
        ? `مستند ${document.documentType} للاختبار يتضمن: ${titleBlock.text.slice(0, 120)}`
        : `مستند ${document.documentType} للاختبار بلا عنوان واضح.`;
      report.evidence = evidence.map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)));
      report.sufficiencyEvidenceIds = evidence.length ? [`ev-1`] : [];
      report.evidenceSufficiency = evidence.length ? "partial" : "insufficient";
      report.confidence = evidence.length ? "medium" : "low";
      if (!evidence.length) report.warnings.push("لا توجد أدلة كافية في المستند؛ evidenceSufficiency=insufficient.");
      return report;
    },
  };
}

// ---------- OllamaProvider: محلي حصرًا، بتفعيل صريح، بلا سحب نماذج وبلا إعادة محاولة ----------
export function createOllamaProvider({ env = {}, fetchFn = globalThis.fetch } = {}) {
  const config = readAnalysisAiConfig(env);
  const host = assertLoopbackOllamaHost(config.ollamaHost);
  return {
    name: "ollama",
    model: config.ollamaModel,
    async analyze({ document, chunks }) {
      if (!config.enabled) {
        throw providerError("AI_PROVIDER_DISABLED", "مزود Ollama معطل؛ فعّل RADAR_AI_ENABLED=true صراحة لاستخدامه.");
      }
      // كتالوج الأدلة الحتمي المحلي (P4-A1D0): مقتطفات حرفية من كتل المستند بمعرفات
      // cand- ثابتة. النموذج يختار المعرفات فقط — لا يكتب excerpt ولا evidence.
      const catalog = buildEvidenceCandidateCatalog({ document, chunks });
      if (!catalog.candidates.length) {
        // بلا مرشحين لا يُستدعى النموذج إطلاقًا: فشل آمن مشفر قبل أي اتصال.
        throw providerError("AI_NO_EVIDENCE_CANDIDATES", "لا توجد مقتطفات صالحة للاقتباس في المستند؛ لا يُستدعى النموذج بلا مرشحين.");
      }
      // المخطط الداخلي الديناميكي: enum المعرفات من كتالوج هذا المستند فقط.
      const selectionSchema = buildModelSelectionSchema(catalog.candidates);
      // يرسل كتالوجًا نصيًا محدودًا (48 مرشحًا / 6000 حرف مقتطفات) — لا ملفات
      // كاملة ولا مسارات ولا بيانات اعتماد.
      const prompt = buildModelSelectionPrompt({ document, catalog });

      const startedAt = Date.now();
      let response;
      try {
        // نقطة التوليد فقط؛ لا سحب نماذج ولا أي endpoint آخر، ومحاولة واحدة بلا إعادة.
        // format يحمل مخطط الاختيار الداخلي analysis-model-selection-v3 (P4-M0BR0)
        // لفرض بنية الاختيار بالمعرف من المصدر؛ validateModelSelection يبقى الحاجز
        // الإلزامي الثاني بعد الاستجابة.
        // P4-M0B2A: think:false يُعطِّل حقل التفكير في النماذج الداعمة (مثل qwen3.8)
        // كي تبقى مخرجات الاختيار في response الرسمي؛ لا يُقرأ حقل thinking إطلاقًا
        // ولا يوجد أي fallback منه، والـformat يبقى كائن JSON Schema المعتمد.
        response = await fetchFn(`${host}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.ollamaModel, prompt, stream: false, format: selectionSchema, options: { temperature: 0 }, think: false }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        throw providerError("AI_PROVIDER_UNAVAILABLE", `تعذر الوصول إلى Ollama المحلي خلال ${config.timeoutMs}ms أو الخدمة غير متاحة.`);
      }
      if (!response.ok) {
        throw providerError("AI_PROVIDER_UNAVAILABLE", `استجابة Ollama غير ناجحة (${response.status})؛ تأكد من توفر النموذج محليًا.`);
      }
      let selection;
      try {
        const body = await response.json();
        const text = String(body?.response || "");
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        selection = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        throw providerError("AI_OUTPUT_INVALID", "مخرجات Ollama ليست JSON صالحًا.");
      }
      // إعادة بناء تقرير analysis-report-v3 canonical من الكتالوج المحلي حرفيًا.
      // أي معرف مجهول أو مكرر أو بنية مشوهة تُرفض هنا بـAI_OUTPUT_INVALID.
      const report = materializeCanonicalReport(selection, catalog);
      // المدة وإحصاء الكتالوج تُعاد ضمن النتيجة للسجل، دون أي نص من الطلب أو الاستجابة.
      return {
        ...report,
        _meta: {
          durationMs: Date.now() - startedAt,
          evidenceCandidates: { sent: catalog.candidates.length, excluded: catalog.excludedCount },
        },
      };
    },
  };
}

export function createAnalysisProvider({ env = {}, fetchFn } = {}) {
  const config = readAnalysisAiConfig(env);
  if (config.provider === "ollama") return createOllamaProvider({ env, fetchFn });
  return createStubProvider();
}

export { analysisPromptVersion, analysisReportSchemaVersion };
