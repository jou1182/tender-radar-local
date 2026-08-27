
import { useCallback, useEffect, useState } from "react";

// ── P5-F1: شاشة «إدارة الوكلاء» — بطاقة تحكم كاملة لكل وكيل ──────────────────
// منفصلة عن قسم «فريق الوكلاء» الاستعراضي: اسم قابل للتعديل، تعليمات سلوك،
// اختبار معزول بمدخل تجريبي، وربط مزود (محلي/خارجي) ببنية agent-team الموجودة.
type ManagedAgent = {
  roleCode: string; nameAr: string; nameEn: string; gender: "male" | "female";
  color: string; roleLabel: string; enabled: boolean; provider: string;
  external: boolean; systemInstructions: string;
};
type SandboxResult = { provider: string; model: string | null; response: string; isolated: boolean; at: string };

import { TeamSecretManager } from "./team-secret-manager";
const SYNC_BASE = "http://127.0.0.1:4318";
const providerNames: Record<string, string> = { stub: "محاكاة آمنة", ollama: "محلي (Ollama)", "openai-compatible": "خارجي (API)" };

function readToken(): string | null {
  // آمن لـSSR: لا يوجد window على الخادم — التوكن يُقرأ في المتصفح فقط بعد الإماهة.
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem("radar-team-token");
}

export function AgentManagementScreen() {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [token, setToken] = useState<string | null>(readToken());
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameEnDraft, setNameEnDraft] = useState("");
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [instructionsSaved, setInstructionsSaved] = useState("");
  const [providerDraft, setProviderDraft] = useState("stub");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [externalConfirmed, setExternalConfirmed] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<SandboxResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [flash, setFlash] = useState("");

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch(`${SYNC_BASE}/agents`);
      if (!res.ok) return;
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch {
      console.debug("[agent-management] service unreachable");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadAgents(), 0);
    const handle = window.setInterval(() => void loadAgents(), 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(handle); };
  }, [loadAgents]);

  async function authenticate() {
    setAuthError("");
    const body = needsSetup
      ? { action: "setup", newSecret: password }
      : { teamSecret: password };
    const res = await fetch(`${SYNC_BASE}/agents/auth`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setAuthError(data.message ?? "فشل التوثيق."); return; }
    window.sessionStorage.setItem("radar-team-token", data.token);
    setToken(data.token); setPassword(""); setAuthError("");
  }

  function toggle(agent: ManagedAgent) {
    setOpenRole(openRole === agent.roleCode ? null : agent.roleCode);
    setNameDraft(agent.nameAr);
    setNameEnDraft(agent.nameEn);
    setInstructionsDraft(agent.systemInstructions || "");
    setInstructionsSaved("");
    setProviderDraft(agent.provider);
    setBaseUrlDraft(""); setModelDraft(""); setApiKeyDraft("");
    setExternalConfirmed(false); setTestInput(""); setTestResult(null); setTestError(""); setFlash("");
  }

  async function post(path: string, payload: Record<string, unknown>) {
    const res = await fetch(`${SYNC_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-team-token": token ?? "" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function saveName(agent: ManagedAgent) {
    const { ok, data } = await post("/agents/update", {
      roleCode: agent.roleCode,
      nameAr: nameDraft,
      nameEn: nameEnDraft || agent.nameEn,
    });
    setFlash(ok ? "تم حفظ الاسم (عربي + إنجليزي) ✓" : data.message ?? "تعذر الحفظ.");
    if (ok) void loadAgents();
  }

  async function saveInstructions(agent: ManagedAgent) {
    const { ok, data } = await post("/agents/instructions", { roleCode: agent.roleCode, instructions: instructionsDraft });
    setInstructionsSaved(ok ? "حُفظت التعليمات ✓" : "");
    setFlash(ok ? "" : data.message ?? "تعذر الحفظ.");
    if (ok) void loadAgents();
  }

  async function saveBinding(agent: ManagedAgent) {
    const binding: Record<string, unknown> = providerDraft === "stub"
      ? { provider: "stub" }
      : { provider: providerDraft, baseUrl: baseUrlDraft, model: modelDraft };
    if (externalConfirmed) binding.externalConfirmed = true;
    const payload: Record<string, unknown> = { roleCode: agent.roleCode, binding };
    if (apiKeyDraft) payload.apiKeyPlaintext = apiKeyDraft;
    const { ok, data } = await post("/agents/binding", payload);
    setFlash(ok ? "تم حفظ الربط ✓" : data.message ?? "تعذر الحفظ.");
    if (ok) { setApiKeyDraft(""); void loadAgents(); }
  }

  async function runTest(agent: ManagedAgent) {
    setTestError(""); setTestResult(null); setTestRunning(true);
    const { ok, data } = await post("/agents/test", {
      roleCode: agent.roleCode,
      testInput: testInput,
      teamSecret: password || undefined,
    });
    setTestRunning(false);
    if (!ok) { setTestError(data.message ?? "فشل الاختبار."); return; }
    setTestResult(data.result);
  }

  if (!agents.length) return null;

  return (
    <section className="agent-management" aria-label="إدارة الوكلاء">
      <div className="agent-team-head">
        <div>
          <p className="eyebrow">لوحة التحكم الكاملة</p>
          <h2>إدارة الوكلاء</h2>
          <p>لكل وكيل: الاسم، تعليمات السلوك، اختبار معزول قبل الاعتماد، وربط مستقل بمزود محلي أو خارجي.</p>
        </div>
        {!token && <span className="team-state">محمية بكلمة سر الفريق</span>}
        {token && <span className="team-state busy" style={{ animation: "none" }}>جلسة إدارة نشطة</span>}
        <TeamSecretManager onSecretChanged={() => void loadAgents()} />
      </div>

      {!token && (
        <div className="agent-auth management-auth">
          <p><b>{needsSetup ? "اضبط كلمة سر الفريق لأول مرة" : "أدخل كلمة سر الفريق"}</b></p>
          {needsSetup && <input type="password" placeholder="كلمة سر جديدة (8 أحرف+)" value={password} onChange={(e) => setPassword(e.target.value)} />}
          <input type="password" placeholder={needsSetup ? "" : "كلمة سر الفريق"} value={password} onChange={(e) => setPassword(e.target.value)} />
          {authError && <em>{authError}</em>}
          <div className="agent-actions">
            <button type="button" onClick={() => void authenticate()}>{needsSetup ? "ضبط ودخول" : "دخول"}</button>
            <button type="button" className="quiet" onClick={() => { setNeedsSetup(!needsSetup); setAuthError(""); }}>
              {needsSetup ? "لديّ كلمة سر" : "أول مرة؟ اضبطها"}
            </button>
          </div>
        </div>
      )}

      {token && (
        <div className="management-grid">
          {agents.map((agent) => (
            <article key={agent.roleCode} className="management-card" style={{ borderInlineStartColor: agent.color }}>
              <header className="management-card-head">
                <span className="management-agent-name" style={{ color: agent.color }}>{agent.nameAr}</span>
                <small>{agent.nameEn} · {agent.roleLabel}</small>
                <span className={`agent-provider ${agent.external ? "external" : ""}`}>
                  {providerNames[agent.provider] ?? agent.provider}{agent.external ? " ⚠" : ""}
                </span>
              </header>

              <button type="button" className="outline-button management-toggle" onClick={() => toggle(agent)}>
                {openRole === agent.roleCode ? "إغلاق التحكم" : "فتح لوحة التحكم"}
              </button>

              {openRole === agent.roleCode && (
                <div className="management-controls">
                  {/* 1) الاسم */}
                  <fieldset><legend>1 · الاسم (عربي + إنجليزي)</legend>
                    <input placeholder="الاسم العربي" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
                    <input placeholder="الاسم الإنجليزي (Latin)" value={nameEnDraft} onChange={(e) => setNameEnDraft(e.target.value)} dir="ltr" />
                    <div className="inline-row">
                      <button type="button" onClick={() => void saveName(agent)}>حفظ الاسم</button>
                    </div>
                  </fieldset>

                  {/* 2) التدريب — تعليمات السلوك */}
                  <fieldset><legend>2 · التدريب (تعليمات السلوك)</legend>
                    <textarea
                      rows={5}
                      placeholder={`مثال: أنت ${agent.nameAr}، مهمتك ${agent.roleLabel}. اتبع هذه القواعد...`}
                      value={instructionsDraft}
                      onChange={(e) => { setInstructionsDraft(e.target.value); setInstructionsSaved(""); }}
                    />
                    <div className="inline-row">
                      <small>{instructionsDraft.length} / 8000</small>
                      <button type="button" onClick={() => void saveInstructions(agent)}>حفظ التعليمات</button>
                      {instructionsSaved && <em className="panel-msg">{instructionsSaved}</em>}
                    </div>
                  </fieldset>

                  {/* 3) الاختبار المعزول */}
                  <fieldset><legend>3 · اختبار معزول (بلا أي أثر على البيانات الحقيقية)</legend>
                    <textarea
                      rows={3}
                      placeholder="اكتب مدخلًا تجريبيًا، مثال: نص منافسة وهمي..."
                      value={testInput}
                      onChange={(e) => setTestInput(e.target.value)}
                    />
                    <div className="inline-row">
                      <button type="button" disabled={testRunning || !testInput.trim()} onClick={() => void runTest(agent)}>
                        {testRunning ? "جارٍ الاختبار…" : "اختبر الوكيل"}
                      </button>
                      {testError && <em className="test-error">{testError}</em>}
                    </div>
                    {testResult && (
                      <pre className="test-output">{testResult.response}</pre>
                    )}
                  </fieldset>

                  {/* 4) مزود الخدمة */}
                  <fieldset><legend>4 · مزود الخدمة (مستقل لكل وكيل)</legend>
                    <select value={providerDraft} onChange={(e) => setProviderDraft(e.target.value)}>
                      <option value="stub">محاكاة آمنة (افتراضي)</option>
                      <option value="ollama">محلي (Ollama)</option>
                      <option value="openai-compatible">خارجي (API متوافق مع OpenAI)</option>
                    </select>
                    {providerDraft !== "stub" && <>
                      <input placeholder={providerDraft === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1"} value={baseUrlDraft} onChange={(e) => setBaseUrlDraft(e.target.value)} />
                      <input placeholder={providerDraft === "ollama" ? "nemotron-3.5-lightning:latest" : "اسم النموذج"} value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} />
                      <input type="password" placeholder="مفتاح API (يُشفَّر ولا يُعرض مجددًا)" value={apiKeyDraft} onChange={(e) => setApiKeyDraft(e.target.value)} />
                      {baseUrlDraft && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrlDraft) && (
                        <label className="confirm-external">
                          <input type="checkbox" checked={externalConfirmed} onChange={(e) => setExternalConfirmed(e.target.checked)} />
                          أؤكد أن بيانات هذا الوكيل ستغادر الجهاز إلى مزود خارجي
                        </label>
                      )}
                    </>}
                    <div className="inline-row">
                      <button type="button" onClick={() => void saveBinding(agent)}>حفظ الربط</button>
                      {flash && <em className="panel-msg">{flash}</em>}
                    </div>
                  </fieldset>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
