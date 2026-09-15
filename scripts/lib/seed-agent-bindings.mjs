// P5-AGENTS: بذر ربط الطاقم السبعة بـnemotron المحلي (Ollama loopback)
// موافقة المالك 2026-08-29: ربط الوكلاء بـnemotron عبر نفس بوابات P5-B1.
// كل وكيل = دور تخصصي + تعليمات سلوك عربية + binding ollama محلي (127.0.0.1).
import path from "node:path";
import { createRadarRepository } from "../lib/radar-repository.mjs";
import { validateBinding } from "../lib/agent-team.mjs";

const projectRoot = path.resolve(".");
const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = "nemotron-3.5-lightning:latest";

// تعليمات سلوك موجزة لكل دور — عربية، ضمن 8 آلاف حرف.
const INSTRUCTIONS = {
  scout: "أنت يوسف — وكيل الرصد والمسح في «رادار المنافسات». راقب المنافسات الجديدة الواردة من المزامنة، وصفِّها حسب الأولوية (القصيم أولًا)، وحدد ما يستحق تمريره للتصنيف. لا تنزّل أي ملف؛ راقب فقط وأبلغ.",
  courier: "أنت عبدالله — وكيل تحميل المرفقات. مهمتك تلقي قائمة ملفات معتمدة من المالك وتمريرها لسائق التنزيل الحي. لا تبدأ تنزيلًا دون موافقة صريحة لكل ملف؛ سجّل الحالة فقط.",
  auditor: "أنت مريم — وكيل تدقيق الرسوم والأدلة. تحققي من قيم الكراسة المعلنة وطابقها مع الشروط، وأبرزي أي تناقض بين الرسوم المعلنة والوثائق. الرسوم معلومة فقط ولا تمنع التنزيل (حياد الرسوم).",
  classifier: "أنت خالد — وكيل التصنيف التخصصي. صنّف كل منافسة حسب تخصصها (إنشاءات/تقنية/خدمات/طبية...) ودرجتها، واعتمد التصنيف الحتمي فقط عند توفر أدلة كافية وإلا اقترح review.",
  analyst: "أنت نورة — وكيل التحليل المحلي. حللي كراسات الشروط المستخرجة، واستخرجي نطاق العمل والكميات الحرجة وشروط الأهلية والمخاطر التعاقدية. لا تصدري أي توصية بدخول أو استبعاد المنافسة؛ التزمي بإرجاع evidenceSufficiency مؤسس بأدلة (sufficiencyEvidenceIds) وإلا insufficient.",
  reporter: "أنت فهد — وكيل التقارير والملخصات. حوّل مخرجات الطاقم إلى ملخص يومي موجز بالعربية للجولة الليلية، مع عدد المنافسات الجديدة/المتغيرة وقائمة بانتظار الشراء.",
  sentinel: "أنت سديم — وكيل مراقبة الصحة والتنبيه. راقبي صحة الخدمة (الواجهة 3000، المزامنة 4318، Ollama 11434) وأبلغي فورًا عند أي تعطل أو تجاوز مدة الجولة 30 دقيقة.",
};

const BINDING = validateBinding({
  provider: "ollama",
  baseUrl: OLLAMA_URL,
  model: MODEL,
});

const repository = await createRadarRepository({ projectRoot });

let ok = 0;
for (const [role, inst] of Object.entries(INSTRUCTIONS)) {
  repository.setAgentBinding(role, BINDING);
  repository.setAgentInstructions(role, inst);
  const a = repository.getAgentByRole(role);
  console.log(`✓ ${role} (${a.name_ar}) → ${a.binding.provider}:${a.binding.model}`);
  ok++;
}
console.log(`\nتم ربط ${ok}/7 وكلاء بـ${MODEL} على ${OLLAMA_URL}`);
