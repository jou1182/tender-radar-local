// محرك اختبار الوكلاء المعزول — P5-F1 (شاشة إدارة الوكلاء)
// يشغّل "تجربة" لوكيل واحد بتعليماته الحالية على مدخل تجريبي من المالك،
// معزول تمامًا عن مسار التشغيل الحقيقي: لا كتابة في أي جدول بيانات،
// ولا اتصال إلا بمزود الوكيل المربوط نفسه (loopback أو الخارجي المصرح).
import { decryptWithPassword as decryptAgentCredential } from "./agent-team.mjs";

const providerTimeoutMs = 60_000;

function agentError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function callOllama({ baseUrl, model, systemInstructions, testInput, apiKey }, signal) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      system: systemInstructions,
      prompt: testInput,
      stream: false,
      think: false,
    }),
    signal,
  });
  if (!response.ok) {
    throw agentError("AGENT_TEST_PROVIDER_ERROR", `استجابة المزود ${response.status}`);
  }
  const data = await response.json();
  return String(data?.response ?? "").trim();
}

async function callOpenAiCompatible({ baseUrl, model, systemInstructions, testInput, apiKey }, signal) {
  if (!apiKey) {
    throw agentError("AGENT_TEST_API_KEY_REQUIRED", "المزود الخارجي يتطلب مفتاح API محفوظًا مسبقًا من لوحة الوكيل.");
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstructions },
        { role: "user", content: testInput },
      ],
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    throw agentError("AGENT_TEST_PROVIDER_ERROR", `استجابة المزود ${response.status}`);
  }
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

// محاكاة آمنة: تعيد تعليمات المدخل كما هي — للوكلاء غير المربوطين بمزود فعلي.
function callStub({ systemInstructions, testInput }) {
  return [
    "[محاكاة آمنة — الوكيل غير مربوط بمزود فعلي]",
    systemInstructions ? `تعليماتي الحالية: ${systemInstructions}` : "لا توجد تعليمات سلوك محفوظة.",
    `مدخل التجربة: ${testInput}`,
  ].join("\n");
}

/**
 * تشغيل تجربة معزولة لوكيل واحد.
 * @param {object} params
 * @param {object} params.agent   صف الوكيل من listAgents/getAgentByRole (يشمل binding)
 * @param {string} params.teamSecret سر الفريق — يُستخدم فقط لفك تشفير مفتاح API عند الحاجة، لا يُسجل أبدًا
 * @param {string} params.testInput نص التجربة الذي كتبه المالك
 * @returns {Promise<{provider, model|null, response, isolated: true, at: string}>}
 */
export async function runAgentSandboxTest({ agent, teamSecret, testInput, timeoutMs = providerTimeoutMs }) {
  if (!agent?.binding) throw agentError("AGENT_NOT_FOUND", "الوكيل غير موجود.");
  const input = String(testInput ?? "").trim();
  if (!input) throw agentError("AGENT_TEST_INPUT_REQUIRED", "اكتب مدخل التجربة أولًا.");
  if (input.length > 20_000) throw agentError("AGENT_TEST_INPUT_TOO_LARGE", "مدخل التجربة يتجاوز 20 ألف حرف.");

  const binding = agent.binding ?? {};
  const provider = String(binding.provider || "stub");
  const systemInstructions = String(agent.system_instructions ?? "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    let usedModel = binding.model ?? null;
    if (provider === "ollama") {
      response = await callOllama({
        baseUrl: binding.baseUrl,
        model: binding.model,
        systemInstructions,
        testInput: input,
        apiKey: null,
      }, controller.signal);
    } else if (provider === "openai-compatible") {
      let apiKey;
      if (binding.apiKeyEncrypted) {
        if (!teamSecret) throw agentError("AGENT_TEST_SECRET_REQUIRED", "سر الفريق مطلوب لفك تشفير مفتاح API.");
        apiKey = decryptAgentCredential(binding.apiKeyEncrypted, teamSecret);
      }
      response = await callOpenAiCompatible({
        baseUrl: binding.baseUrl,
        model: binding.model,
        systemInstructions,
        testInput: input,
        apiKey,
      }, controller.signal);
    } else {
      response = callStub({ systemInstructions, testInput: input });
      usedModel = null;
    }
    return { provider, model: usedModel, response, isolated: true, at: new Date().toISOString() };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw agentError("AGENT_TEST_TIMEOUT", `انتهت مهلة استجابة المزود بعد ${Math.round(timeoutMs / 1000)} ثانية.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
