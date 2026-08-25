// اختبارات P5-F0 — طاقم الوكلاء: Schema v9، التسمية، الربط المشفر، كلمة السر، الجلسات
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";
import {
  defaultAgents,
  validateBinding,
  encryptWithPassword,
  decryptWithPassword,
  setTeamCredential,
  verifyTeamPassphrase,
  createSessionManager,
} from "../scripts/lib/agent-team.mjs";

async function makeProjectRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("P5-F0-1: fresh database seeds the default seven-agent team at schema v9", async () => {
  const projectRoot = await makeProjectRoot("radar-p5f0-fresh-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    assert.equal(repo.schemaVersion, 9);
    const agents = repo.listAgents();
    assert.equal(agents.length, defaultAgents.length);
    assert.equal(agents[0].name_ar, "يوسف");
    assert.ok(agents.some((a) => a.name_ar === "مريم" && a.gender === "female"));
    assert.ok(agents.every((a) => a.binding.provider === "stub"));
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-F0-2: renaming an agent persists across reopen and re-seeding does not overwrite it", async () => {
  const projectRoot = await makeProjectRoot("radar-p5f0-rename-");
  try {
    const first = await createRadarRepository({ projectRoot });
    first.updateAgentProfile("scout", { nameAr: "سالم", nameEn: "Salem" });
    first.close();
    const second = await createRadarRepository({ projectRoot });
    const scout = second.getAgentByRole("scout");
    assert.equal(scout.name_ar, "سالم");
    assert.equal(scout.name_en, "Salem");
    second.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-F0-3: binding validation — stub always ok; ollama needs base url + model; external needs confirmation", () => {
  assert.deepEqual(validateBinding({ provider: "stub" }), { provider: "stub" });
  const local = validateBinding({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nemotron-3.5-lightning:latest" });
  assert.equal(local.model, "nemotron-3.5-lightning:latest");
  assert.throws(
    () => validateBinding({ provider: "ollama", model: "x" }),
    (e) => e.code === "AGENT_BASE_URL_REQUIRED",
  );
  assert.throws(
    () => validateBinding({ provider: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "gpt" }),
    (e) => e.code === "AGENT_EXTERNAL_CONFIRMATION_REQUIRED",
  );
  const ext = validateBinding({
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "gpt",
    externalConfirmed: true,
  });
  assert.equal(ext.baseUrl, "https://api.example.com/v1");
});

test("P5-F0-4: api keys are stored encrypted with the team password and never in plaintext", async () => {
  const projectRoot = await makeProjectRoot("radar-p5f0-crypto-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    setTeamCredential(repo, { newSecret: "سر-الفريق-1234" });
    assert.equal(verifyTeamPassphrase(repo, "سر-الفريق-1234"), true);
    assert.equal(verifyTeamPassphrase(repo, "خطأ"), false);

    const sealed = encryptWithPassword("sk-secret-key", "سر-الفريق-1234");
    repo.setAgentBinding("analyst", {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "gpt",
      apiKey: sealed,
    });
    const raw = JSON.stringify(repo.getPolicySettingRaw("__none__") || {}) +
      repo.listRecentAgentActivity(0).length;
    const agent = repo.getAgentByRole("analyst");
    const bindingText = JSON.stringify(agent.binding);
    assert.ok(!bindingText.includes("sk-secret-key"), "plaintext key must never be stored");
    assert.equal(decryptWithPassword(agent.binding.apiKey, "سر-الفريق-1234"), "sk-secret-key");
    assert.throws(() => decryptWithPassword(agent.binding.apiKey, "كلمة-خاطئة"));
    void raw;
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-F0-5: team credential is set once then requires the current password to change", async () => {
  const projectRoot = await makeProjectRoot("radar-p5f0-cred-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    setTeamCredential(repo, { newSecret: "كلمة-السر-الأولى" });
    assert.throws(
      () => setTeamCredential(repo, { newSecret: "ثانية-8chars" }),
      (e) => e.code === "TEAM_CREDENTIAL_REQUIRED",
    );
    setTeamCredential(repo, { newSecret: "ثانية-8chars", currentSecret: "كلمة-السر-الأولى" });
    assert.equal(verifyTeamPassphrase(repo, "ثانية-8chars"), true);
    assert.throws(
      () => setTeamCredential(repo, { newSecret: "ثالثة-8chars", currentSecret: "خاطئة" }),
      (e) => e.code === "TEAM_CREDENTIAL_MISMATCH",
    );
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("P5-F0-6: session tokens verify within ttl and fail after expiry or tampering", () => {
  let tick = 1_000_000_000_000;
  const clock = () => tick;
  const sessions = createSessionManager({ secret: "s3cret", clock });
  const { token } = sessions.issue();
  assert.equal(sessions.verify(token), true);
  tick += 31 * 60_000;
  assert.equal(sessions.verify(token), false);
  tick -= 31 * 60_000;
  const forged = `${token.slice(0, -2)}xx`;
  assert.equal(sessions.verify(forged), false);
});

test("P5-F0-7: agent activity feed records and lists newest-first", async () => {
  const projectRoot = await makeProjectRoot("radar-p5f0-activity-");
  try {
    const repo = await createRadarRepository({ projectRoot });
    repo.recordAgentActivity({ roleCode: "scout", action: "sync-complete", status: "success", detail: { checked: 225 } });
    repo.recordAgentActivity({ roleCode: "sentinel", action: "health-check", status: "warning", detail: { wal: "large" } });
    const feed = repo.listRecentAgentActivity(10);
    assert.equal(feed[0].action, "health-check");
    assert.equal(feed[feed.length - 1].action, "sync-complete");
    repo.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
