// فريق وكلاء «رادار المنافسات» — P5-F0
// الطاقم الافتراضي، التحقق من الربط بالمزودين، تشفير الأسرار (AES-256-GCM بمفتاح
// مشتق من كلمة سر الفريق عبر scrypt)، وجلسات التوثيق (HMAC بذاكرة العملية).
// قرار المالك الموثق: يُسمح بربط وكلاء بمزود خارجي — مغلق افتراضيًا ولكل وكيل
// على حدة، بكلمة سر الفريق، والمفتاح لا يُخزن ولا يُعرض مكشوفًا أبدًا.
import crypto from "node:crypto";

export const teamCredentialPolicyKey = "teamAdminCredential";
const sessionTtlMs = 30 * 60_000;

export const defaultAgents = [
  { roleCode: "scout",      nameAr: "يوسف",    nameEn: "Yusuf",    gender: "male",   color: "#14b8a6", displayOrder: 1, roleLabel: "الرصد والمسح" },
  { roleCode: "courier",    nameAr: "عبدالله", nameEn: "Abdullah", gender: "male",   color: "#f59e0b", displayOrder: 2, roleLabel: "تحميل المرفقات" },
  { roleCode: "auditor",    nameAr: "مريم",    nameEn: "Maryam",   gender: "female", color: "#f43f5e", displayOrder: 3, roleLabel: "تدقيق الرسوم والأدلة" },
  { roleCode: "classifier", nameAr: "خالد",    nameEn: "Khalid",   gender: "male",   color: "#6366f1", displayOrder: 4, roleLabel: "التصنيف التخصصي" },
  { roleCode: "analyst",    nameAr: "نورة",    nameEn: "Noura",    gender: "female", color: "#8b5cf6", displayOrder: 5, roleLabel: "التحليل المحلي" },
  { roleCode: "reporter",   nameAr: "فهد",     nameEn: "Fahad",    gender: "male",   color: "#10b981", displayOrder: 6, roleLabel: "التقارير والملخصات" },
  { roleCode: "sentinel",   nameAr: "سديم",    nameEn: "Sadeem",   gender: "female", color: "#0ea5e9", displayOrder: 7, roleLabel: "مراقبة الصحة والتنبيه" },
];

export function agentTeamError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertNonEmptyString(value, code, message) {
  const text = String(value ?? "").trim();
  if (!text) throw agentTeamError(code, message);
  return text;
}

export function validateBinding(binding) {
  if (!binding || typeof binding !== "object") {
    throw agentTeamError("AGENT_BINDING_INVALID", "الربط مطلوب بصيغة كائن.");
  }
  const provider = String(binding.provider || "").trim();
  if (!["stub", "ollama", "openai-compatible"].includes(provider)) {
    throw agentTeamError("AGENT_PROVIDER_UNKNOWN", `مزود غير معروف: ${provider || "فارغ"}`);
  }
  const normalized = { provider };
  if (provider === "stub") return normalized;
  const baseUrl = String(binding.baseUrl || "").trim();
  if (!baseUrl) {
    throw agentTeamError("AGENT_BASE_URL_REQUIRED", "رابط الخدمة مطلوب لهذا المزود.");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw agentTeamError("AGENT_BASE_URL_INVALID", `رابط الخدمة غير صالح: ${baseUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !binding.externalConfirmed) {
    throw agentTeamError(
      "AGENT_EXTERNAL_CONFIRMATION_REQUIRED",
      "المزود خارج الجهاز — يتطلب تأكيدًا صريحًا بأن البيانات ستغادر الجهاز.",
    );
  }
  normalized.baseUrl = baseUrl.replace(/\/+$/, "");
  const model = String(binding.model || "").trim();
  if (!model) {
    throw agentTeamError("AGENT_MODEL_REQUIRED", "اسم النموذج مطلوب لهذا المزود.");
  }
  normalized.model = model;
  if (binding.apiKey && typeof binding.apiKey === "object" && binding.apiKey.ciphertext) {
    normalized.apiKeyEncrypted = {
      ciphertext: String(binding.apiKey.ciphertext),
      iv: String(binding.apiKey.iv),
      authTag: String(binding.apiKey.authTag),
    };
  }
  return normalized;
}

// ── تشفير الأسرار بمفتاح مشتق من كلمة سر الفريق ─────────────────────────────
export function encryptWithPassword(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    kdfSalt: salt.toString("base64"),
  };
}

export function decryptWithPassword(sealed, password) {
  const key = crypto.scryptSync(
    String(password),
    Buffer.from(String(sealed.kdfSalt), "base64"),
    32,
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(sealed.iv), "base64"),
  );
  decipher.setAuthTag(Buffer.from(String(sealed.authTag), "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(sealed.ciphertext), "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

// ── كلمة سر الفريق ───────────────────────────────────────────────────────────
// تُضبط أول مرة فقط؛ بعدها أي تغيير يتطلب كلمة السر الحالية.
export function setTeamCredential(store, { newSecret, currentSecret }) {
  const existingRaw = store.getPolicySettingRaw(teamCredentialPolicyKey);
  if (existingRaw) {
    assertNonEmptyString(currentSecret, "TEAM_CREDENTIAL_REQUIRED", "السر الحالي مطلوب.");
    const existing = JSON.parse(existingRaw.value_json);
    if (existing.scryptHash !== scryptHash(currentSecret, existing.kdfSalt)) {
      throw agentTeamError("TEAM_CREDENTIAL_MISMATCH", "كلمة السر الحالية غير صحيحة.");
    }
  }
  const secret = assertNonEmptyString(newSecret, "TEAM_CREDENTIAL_WEAK", "السر الجديد مطلوب.");
  if (secret.length < 8) {
    throw agentTeamError("TEAM_CREDENTIAL_WEAK", "السر يجب أن يكون 8 أحرف على الأقل.");
  }
  const kdfSalt = crypto.randomBytes(16).toString("base64");
  store.setPolicySetting(teamCredentialPolicyKey, {
    kdfSalt,
    scryptHash: scryptHash(secret, kdfSalt),
  });
}

export function verifyTeamPassphrase(store, teamSecret) {
  const raw = store.getPolicySettingRaw(teamCredentialPolicyKey);
  if (!raw) {
    throw agentTeamError("TEAM_CREDENTIAL_NOT_SET", "لم تُضبط كلمة سر الفريق بعد — اضبطها أولًا.");
  }
  const stored = JSON.parse(raw.value_json);
  return stored.scryptHash === scryptHash(teamSecret, stored.kdfSalt);
}

function scryptHash(password, kdfSaltBase64) {
  return crypto
    .scryptSync(String(password), Buffer.from(kdfSaltBase64, "base64"), 32)
    .toString("base64");
}

// ── جلسات الإدارة (بذاكرة العملية — تنتهي بإعادة تشغيل الخدمة أو بعد 30 دقيقة) ──
export function createSessionManager({ secret, clock = Date.now } = {}) {
  return {
    issue() {
      const issuedAt = Number(clock());
      const payload = `${issuedAt + sessionTtlMs}`;
      const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
      return { token: `${payload}.${signature}`, expiresAt: new Date(issuedAt + sessionTtlMs).toISOString() };
    },
    verify(token) {
      const [payload, signature] = String(token || "").split(".");
      if (!payload || !signature) return false;
      if (Number(payload) < Number(clock())) return false;
      const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
      try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      } catch {
        return false;
      }
    },
  };
}
