// P5-AGENTS-READY — اختبارات معزولة (قواعد مؤقتة خارج المستودع، بلا شبكة خارجية):
// (أ) تحقق تعريف الطاقم الصافي، (ب) سلوك أداة التطبيق عبر CLI حقيقي.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { agentCrew, validateCrew, crewInstructionLimit } from "../scripts/lib/agent-crew-p5ready.mjs";

const run = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/apply-agent-crew.mjs", import.meta.url));

async function tempRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `radar-crew-${label}-`));
  const repository = await createRadarRepository({ projectRoot: root });
  repository.close();
  return root;
}

async function cli(args, { expectFail = false } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
    assert.equal(expectFail, false, `كان متوقعًا فشل الأمر لكنه نجح:\n${stdout}`);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    assert.equal(expectFail, true, `فشل غير متوقع: ${error.stderr || error.message}`);
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
}

// ── (أ) تحقق التعريف ─────────────────────────────────────────────────────────

test("CREW-1: تعريف الطاقم الحقيقي يجتاز التحقق (7 أدوار، محلي، ضمن الحد)", () => {
  assert.deepEqual(validateCrew(agentCrew), [], "التعريف سليم بلا مشاكل");
  assert.equal(Object.keys(agentCrew).length, 7, "سبعة أدوار");
  for (const [role, entry] of Object.entries(agentCrew)) {
    assert.ok(entry.instructions.trim().length > 0, `${role}: تعليمات غير فارغة`);
    assert.ok(entry.instructions.length <= crewInstructionLimit, `${role}: ضمن حد 8000`);
    assert.ok(entry.model.trim().length > 0, `${role}: نموذج محدَّد`);
  }
});

test("CREW-2: التحقق يرفض الانحرافات (خارجي/فراغ/تجاوز الحد)", () => {
  assert.ok(validateCrew({}).length > 0, "طاقم فارغ مرفوض");
  assert.ok(validateCrew({ scout: { model: "qwen2.5:14b", instructions: "   " } }).some((p) => p.includes("فارغة")), "تعليمات فارغة مرفوضة");
  assert.ok(validateCrew({ scout: { model: "", instructions: "نص" } }).some((p) => p.includes("نموذج فارغ")), "نموذج فارغ مرفوض");
  assert.ok(validateCrew({ scout: { model: "gpt-5", instructions: "نص" } }).some((p) => p.includes("خارجي")), "نموذج خارجي مرفوض");
  assert.ok(validateCrew({ scout: { model: "qwen 2.5", instructions: "نص" } }).some((p) => p.includes("مسافة")), "مسافة في اسم النموذج مرفوضة");
  const long = "ا".repeat(crewInstructionLimit + 1);
  assert.ok(validateCrew({ scout: { model: "qwen2.5:14b", instructions: long } }).some((p) => p.includes(String(crewInstructionLimit))), "تجاوز الحد مرفوض");
});

// ── (ب) أداة التطبيق ────────────────────────────────────────────────────────

test("CREW-3: بلا --db-root يرفض التنفيذ (لا مسار ضمني من مجلد التشغيل)", async () => {
  const res = await cli([], { expectFail: true });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--db-root/);
});

test("CREW-4: مسار بلا .radar-data يرفض بلا أي كتابة", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "radar-crew-empty-"));
  const res = await cli(["--db-root", empty], { expectFail: true });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /\.radar-data/);
});

test("CREW-5: المعاينة افتراضية — لا تكتب شيئًا", async () => {
  const root = await tempRoot("dry");
  const res = await cli(["--db-root", root]);
  assert.match(res.stdout, /معاينة/);
  const repository = await createRadarRepository({ projectRoot: root });
  const agent = repository.getAgentByRole("scout");
  assert.deepEqual(agent.binding, { provider: "stub" }, "الربط لم يتغيّر في المعاينة");
  assert.equal(agent.system_instructions, "", "التعليمات لم تُكتب في المعاينة");
  repository.close();
});

test("CREW-6: --apply يضبط الربط والتعليمات ولا يمس الأسماء/الحالة/الترتيب", async () => {
  const root = await tempRoot("apply");
  const before = await createRadarRepository({ projectRoot: root });
  const snapshot = before.listAgents().map((a) => ({ role: a.role_code, ar: a.name_ar, en: a.name_en, enabled: a.enabled, order: a.display_order }));
  before.close();

  const res = await cli(["--db-root", root, "--apply"]);
  assert.match(res.stdout, /تم التطبيق/);

  const after = await createRadarRepository({ projectRoot: root });
  for (const agent of after.listAgents()) {
    assert.equal(agent.binding.provider, "ollama", `${agent.role_code}: مزوّد محلي`);
    assert.equal(agent.binding.baseUrl, "http://127.0.0.1:11434", `${agent.role_code}: loopback`);
    assert.equal(agent.system_instructions, agentCrew[agent.role_code].instructions, `${agent.role_code}: التعليمات المطبَّقة`);
    const prev = snapshot.find((s) => s.role === agent.role_code);
    assert.equal(agent.name_ar, prev.ar, "الاسم العربي لم يُمَس");
    assert.equal(agent.name_en, prev.en, "الاسم الإنجليزي لم يُمَس");
    assert.equal(agent.enabled, prev.enabled, "حالة التشغيل لم تُمَس");
    assert.equal(agent.display_order, prev.order, "الترتيب لم يُمَس");
  }
  const activity = after.listRecentAgentActivity(20).filter((a) => a.action === "crew-applied");
  assert.equal(activity.length, 7, "سجل نشاط لكل وكيل تغيّر (تدقيق)");
  after.close();
});

test("CREW-7: إعادة التطبيق لا تحدث فرقًا (idempotent) وتُبلَّغ كـ«لا تغيير»", async () => {
  const root = await tempRoot("again");
  await cli(["--db-root", root, "--apply"]);
  const second = await cli(["--db-root", root, "--apply"]);
  assert.match(second.stdout, /مطابق بالفعل/);
  assert.match(second.stdout, /تم التطبيق: 0 وكيلًا/);
});

test("CREW-8: --only يقيّد الأدوار، والوكيل المجهول يُرفض", async () => {
  const root = await tempRoot("only");
  await cli(["--db-root", root, "--apply", "--only", "scout"]);
  const repository = await createRadarRepository({ projectRoot: root });
  assert.equal(repository.getAgentByRole("scout").binding.provider, "ollama", "الدور المطلوب طُبِّق");
  assert.deepEqual(repository.getAgentByRole("courier").binding, { provider: "stub" }, "بقية الأدوار لم تُمس");
  repository.close();

  const bad = await cli(["--db-root", root, "--only", "ghost"], { expectFail: true });
  assert.match(bad.stderr, /غير معروفة/);
});

test("CREW-9: معامل غير معروف يُرفض برسالة نظيفة (بلا stack trace)", async () => {
  const res = await cli(["--bogus"], { expectFail: true });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /معامل غير معروف/);
  assert.doesNotMatch(res.stderr, /at Object|node:internal/, "لا stack trace");
});

test("CREW-10: هوية الهدف مؤكَّدة — مجلد .radar-data بلا قاعدة يُرفض إلا بعلم صريح", async () => {
  // ملاحظة المراجعة S1: وجود .radar-data وحده لا يكفي (مجلدات شقيقة كثيرة في الشجرة).
  const root = await mkdtemp(path.join(os.tmpdir(), "radar-crew-nodb-"));
  await mkdir(path.join(root, ".radar-data"), { recursive: true });
  const refused = await cli(["--db-root", root, "--apply"], { expectFail: true });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /غير مؤكَّد الهوية|لا توجد قاعدة/);
  assert.ok(!existsSync(path.join(root, ".radar-data", "radar.sqlite")), "لم تُنشأ قاعدة عند الرفض");

  const allowed = await cli(["--db-root", root, "--apply", "--allow-empty-db"]);
  assert.match(allowed.stdout, /هدف جديد بعلم صريح/);
  const repository = await createRadarRepository({ projectRoot: root });
  assert.equal(repository.getAgentByRole("scout").binding.provider, "ollama", "طُبِّق بعلم صريح");
  repository.close();
});
