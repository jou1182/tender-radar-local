import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import { validateBinding } from "../scripts/lib/agent-team.mjs";

test("P5-AGENTS: الطاقم السبعة يُربط بـnemotron المحلي ويُخزَّن binding صالح", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-agents-"));
  try {
    const repository = await createRadarRepository({ projectRoot });
    const binding = validateBinding({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "nemotron-3.5-lightning:latest",
    });
    const roles = ["scout", "courier", "auditor", "classifier", "analyst", "reporter", "sentinel"];
    for (const role of roles) {
      const a = repository.setAgentBinding(role, binding);
      assert.equal(a.binding.provider, "ollama");
      assert.equal(a.binding.model, "nemotron-3.5-lightning:latest");
      assert.equal(a.binding.baseUrl, "http://127.0.0.1:11434");
    }
    // all seven persisted
    const agents = repository.listAgents();
    const boundToNemotron = agents.filter(
      (x) => x.binding?.provider === "ollama" && x.binding?.model?.includes("nemotron"),
    );
    assert.equal(boundToNemotron.length, 7, "كل الوكلاء السبعة مربوطون بـnemotron");
    // أغلق مقابض DB قبل حذف مجلد الاختبار
    if (repository.close) await repository.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-AGENTS: validateBinding ترفض مزودًا خارجيًا بلا تأكيد", async () => {
  assert.throws(
    () => validateBinding({ provider: "ollama", baseUrl: "https://api.remote.x", model: "x" }),
    (e) => e.code === "AGENT_EXTERNAL_CONFIRMATION_REQUIRED",
  );
});
