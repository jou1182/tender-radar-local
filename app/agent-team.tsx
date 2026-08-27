
import { useCallback, useEffect, useState } from "react";
import { TeamSecretManager } from "./team-secret-manager";
import { RadarMark } from "./radar-mark";

// ── P5-F0: فريق وكلاء الرادار ─────────────────────────────────────────────────
type AgentRow = {
  roleCode: string; nameAr: string; nameEn: string; gender: "male" | "female";
  color: string; roleLabel: string; enabled: boolean; displayOrder: number;
  provider: string; external: boolean; updatedAt?: string;
};
type AgentActivity = { id: number; agent_role_code: string; action: string; status: string; created_at: string };

function shade(hex: string, percent: number) {
  const num = parseInt(hex.replace("#", ""), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((num >> 16) + Math.round(2.55 * percent));
  const g = clamp(((num >> 8) & 0xff) + Math.round(2.55 * percent));
  const b = clamp((num & 0xff) + Math.round(2.55 * percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function AgentAvatar({ agent, active }: { agent: AgentRow; active: boolean }) {
  const skin = "#e8b98a";
  const hair = agent.gender === "female" ? shade(agent.color, -35) : "#3f4652";
  return (
    <svg viewBox="0 0 64 64" className={`agent-avatar ${active ? "working" : ""}`} width="56" height="56" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill={shade(agent.color, 78)} stroke={agent.color} strokeWidth="2.5" />
      <path d="M14 58 C14 44, 24 40, 32 40 C40 40, 50 44, 50 58 Z" fill={agent.color} />
      <circle cx="32" cy="26" r="11" fill={skin} />
      {agent.gender === "female"
        ? <path d="M20 27 C18 12, 46 12, 44 27 L44 38 C40 34, 24 34, 20 38 Z" fill={hair} />
        : <path d="M22 22 C23 15, 41 15, 42 22 C42 19, 39 13, 32 13 C25 13, 22 19, 22 22 Z" fill={hair} />}
      <circle cx="28" cy="26" r="1.6" fill="#2b2f36" />
      <circle cx="36" cy="26" r="1.6" fill="#2b2f36" />
      <path d="M28.5 31 Q32 33.5, 35.5 31" stroke="#2b2f36" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      {active && <circle className="pulse-ring" cx="32" cy="32" r="30" fill="none" stroke={agent.color} strokeWidth="2" />}
    </svg>
  );
}

const providerLabels: Record<string, string> = { stub: "محاكاة آمنة", ollama: "Ollama محلي", "openai-compatible": "مزود خارجي (API)" };

function activityLabel(action: string) {
  switch (action) {
    case "sync-complete": return "أكمل جولة مسح للمنافسات";
    case "profile-updated": return "عدّل أحد ملفاته الشخصية";
    case "binding-updated": return "تحديث الربط بالمزود";
    case "team-credential-set": return "ضبط كلمة سر الفريق";
    default: return action;
  }
}

export function AgentTeamPanel({ syncState, lastSyncAt }: { syncState: string; lastSyncAt?: string | null }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authError, setAuthError] = useState("");
  const [editName, setEditName] = useState("");
  const [editProvider, setEditProvider] = useState("stub");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [externalConfirmed, setExternalConfirmed] = useState(false);
  const [panelMessage, setPanelMessage] = useState("");

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("http://127.0.0.1:4318/agents");
      if (!res.ok) return;
      const data = await res.json();
      setAgents(data.agents ?? []);
      setActivity(data.activity ?? []);
    } catch {
      // الخدمة متوقفة — تظل البطاقات مخفية بهدوء (سجل مقصود غير صامت).
      console.debug("[agent-team] sync service unreachable; cards hidden");
    }
  }, []);

  useEffect(() => {
    // الجلب داخل مؤقت أولي: setState يحدث في callback خارج دورة الرندر (قاعدة react-hooks).
    const initial = window.setTimeout(() => void loadAgents(), 0);
    const handle = window.setInterval(() => void loadAgents(), 20000);
    return () => { window.clearTimeout(initial); window.clearInterval(handle); };
  }, [loadAgents]);

  useEffect(() => {
    if (syncState !== "pending") return;
    const handle = window.setTimeout(() => void loadAgents(), 0);
    return () => window.clearTimeout(handle);
  }, [syncState, lastSyncAt, loadAgents]);

  function openPanel(agent: AgentRow) {
    setOpenRole(agent.roleCode); setEditName(agent.nameAr); setEditProvider(agent.provider);
    setEditBaseUrl(""); setEditModel(""); setEditApiKey(""); setExternalConfirmed(false);
    setAuthError(""); setPanelMessage("");
    setToken(window.sessionStorage.getItem("radar-team-token"));
    setPassword(""); setNewPassword("");
  }

  async function authenticate(action: "login" | "setup") {
    setAuthError("");
    const body = action === "setup"
      ? { action: "setup", newSecret: newPassword, currentSecret: password || undefined }
      : { teamSecret: password };
    const res = await fetch("http://127.0.0.1:4318/agents/auth", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setAuthError(data.message ?? "فشل التوثيق."); return; }
    window.sessionStorage.setItem("radar-team-token", data.token);
    setToken(data.token); setPassword(""); setNewPassword(""); setAuthError("");
  }

  async function saveProfile(agent: AgentRow, enabled: boolean) {
    const res = await fetch("http://127.0.0.1:4318/agents/update", {
      method: "POST",
      headers: { "content-type": "application/json", "x-team-token": token ?? "" },
      body: JSON.stringify({ roleCode: agent.roleCode, nameAr: editName || agent.nameAr, enabled }),
    });
    const data = await res.json().catch(() => ({}));
    setPanelMessage(res.ok ? "تم الحفظ ✓" : data.message ?? "تعذر الحفظ.");
    if (res.ok) void loadAgents();
  }

  async function saveBinding(agent: AgentRow) {
    const binding: Record<string, unknown> = editProvider === "stub"
      ? { provider: "stub" }
      : { provider: editProvider, baseUrl: editBaseUrl, model: editModel };
    if (externalConfirmed) binding.externalConfirmed = true;
    const payload: Record<string, unknown> = { roleCode: agent.roleCode, binding };
    if (editApiKey) payload.apiKeyPlaintext = editApiKey;
    const res = await fetch("http://127.0.0.1:4318/agents/binding", {
      method: "POST",
      headers: { "content-type": "application/json", "x-team-token": token ?? "" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    setPanelMessage(res.ok ? "تم تحديث الربط ✓" : data.message ?? "تعذر التحديث.");
    if (res.ok) { setEditApiKey(""); void loadAgents(); }
  }

  if (!agents.length) return null;
  const working = syncState === "pending";

  return (
    <section className="agent-team" aria-label="فريق وكلاء رادار المنافسات">
      <div className="agent-team-head">
        <div className="agent-team-title"><RadarMark size={44} animate /><div><p className="eyebrow">طاقم الوكلاء الأذكياء</p><h2>فريقك يعمل الآن — كل وكيل بمهمته</h2><p>اضغط أي وكيل لفتح لوحته الفرعية: إعادة التسمية، التمكين، وربطه بمزود محلي أو خارجي.</p></div></div>
        <span className={`team-state ${working ? "busy" : ""}`}>{working ? "الطاقم يعمل…" : "جاهز للأمر"}</span>
      </div>
      <div className="agent-grid">
        {agents.map((agent) => (
          <article key={agent.roleCode} className={`agent-card ${agent.enabled ? "" : "disabled"} ${openRole === agent.roleCode ? "open" : ""}`}>
            <button type="button" className="agent-open" onClick={() => openPanel(agent)}>
              <AgentAvatar agent={agent} active={working && agent.enabled} />
              <b>{agent.nameAr}</b>
              <small>{agent.nameEn}</small>
              <span className="agent-role">{agent.roleLabel}</span>
              <span className="agent-provider">{providerLabels[agent.provider] ?? agent.provider}{agent.external ? " ⚠ خارجي" : ""}</span>
            </button>
            {openRole === agent.roleCode && (
              <div className="agent-panel">
                {!token && (
                  <div className="agent-auth">
                    <p><b>{needsSetup ? "اضبط كلمة سر الفريق لأول مرة" : `لوحة ${agent.nameAr} محمية`}</b></p>
                    {!needsSetup && <input type="password" placeholder="كلمة سر الفريق" value={password} onChange={(e) => setPassword(e.target.value)} />}
                    {needsSetup && <>
                      <input type="password" placeholder="كلمة سر جديدة (8 أحرف+)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                      <input type="password" placeholder="تأكيد كلمة السر الحالية (إن وُجدت)" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </>}
                    {authError && <em>{authError}</em>}
                    <div className="agent-actions">
                      <button type="button" onClick={() => void authenticate(needsSetup ? "setup" : "login")}>{needsSetup ? "ضبط وحفظ" : "دخول"}</button>
                      <button type="button" className="quiet" onClick={() => { setNeedsSetup(!needsSetup); setAuthError(""); }}>{needsSetup ? "لديّ كلمة سر" : "أول مرة؟ اضبطها"}</button>
                      <button type="button" className="quiet" onClick={() => setOpenRole(null)}>إغلاق</button>
                    </div>
                    <TeamSecretManager />
                  </div>
                )}
                {token && (
                  <div className="agent-manage">
                    <label>الاسم العربي<input value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
                    <label>المزود
                      <select value={editProvider} onChange={(e) => setEditProvider(e.target.value)}>
                        <option value="stub">محاكاة آمنة (افتراضي)</option>
                        <option value="ollama">Ollama المحلي</option>
                        <option value="openai-compatible">API خارجي (OpenAI-compatible)</option>
                      </select>
                    </label>
                    {editProvider !== "stub" && <>
                      <label>رابط الخدمة<input placeholder={editProvider === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1"} value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} /></label>
                      <label>النموذج<input placeholder={editProvider === "ollama" ? "nemotron-3.5-lightning:latest" : "model-name"} value={editModel} onChange={(e) => setEditModel(e.target.value)} /></label>
                      <label>مفتاح API (اختياري — يشفَّر ولا يعود ظاهرًا)<input type="password" value={editApiKey} onChange={(e) => setEditApiKey(e.target.value)} /></label>
                      {editBaseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(editBaseUrl) && (
                        <label className="confirm-external"><input type="checkbox" checked={externalConfirmed} onChange={(e) => setExternalConfirmed(e.target.checked)} /> أؤكد أن البيانات ستغادر هذا الجهاز إلى مزود خارجي</label>
                      )}
                    </>}
                    {panelMessage && <em className="panel-msg">{panelMessage}</em>}
                    <div className="agent-actions">
                      <button type="button" onClick={() => void saveBinding(agent)}>حفظ الربط</button>
                      <button type="button" className="outline-button" onClick={() => void saveProfile(agent, !agent.enabled)}>{agent.enabled ? "تعطيل الوكيل" : "تمكين الوكيل"}</button>
                      <button type="button" className="outline-button" onClick={() => void saveProfile(agent, agent.enabled)}>حفظ الاسم</button>
                      <button type="button" className="quiet" onClick={() => setOpenRole(null)}>إغلاق</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {activity.length > 0 && (
        <div className="agent-feed">
          <b>آخر نشاط الطاقم</b>
          <ul>{activity.slice(0, 6).map((item) => (
            <li key={item.id}>
              <span className={`feed-dot ${item.status}`} />
              <b>{agents.find((a) => a.roleCode === item.agent_role_code)?.nameAr ?? item.agent_role_code}</b>
              <span>{activityLabel(item.action)}</span>
              <time>{new Date(item.created_at).toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" })}</time>
            </li>
          ))}</ul>
        </div>
      )}
    </section>
  );
}
