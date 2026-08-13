import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../automation/n8n/radar-phase-1.workflow.json", import.meta.url);

test("n8n phase one workflow is importable and contains no AI or file nodes", async () => {
  const workflow = JSON.parse(await readFile(workflowUrl, "utf8"));
  const types = workflow.nodes.map((node) => node.type);
  assert.equal(workflow.active, true);
  assert.ok(types.includes("n8n-nodes-base.webhook"));
  assert.ok(types.includes("n8n-nodes-base.code"));
  assert.ok(types.includes("n8n-nodes-base.respondToWebhook"));
  assert.ok(!types.some((type) => /langchain|ollama|openai|readWriteFile|extractFromFile/i.test(type)));
  const code = workflow.nodes.find((node) => node.type === "n8n-nodes-base.code").parameters.jsCode;
  assert.doesNotMatch(code, /password|username|cookie|otp/i);
  assert.match(code, /getWorkflowStaticData/);
  assert.match(code, /processedSyncIds/);
});

test("n8n phase one deduplicates sync ids and detects changed tender fields", async () => {
  const workflow = JSON.parse(await readFile(workflowUrl, "utf8"));
  const code = workflow.nodes.find((node) => node.type === "n8n-nodes-base.code").parameters.jsCode;
  const execute = new Function("$input", "$getWorkflowStaticData", code);
  const store = {};
  const tender = { reference: "260000000001", title: "صيانة مبنى", agency: "جهة اختبار", fee: 0, region: "منطقة القصيم", deadline: "2026-08-30", publishedAt: "2026-08-12", platformStatus: "نشطة", activity: "المقاولات", etimadUrl: "https://tenders.etimad.sa/Tender/Details" };
  const run = (body) => execute({ first: () => ({ json: { body } }) }, () => store)[0].json;
  const base = { schemaVersion: 1, source: "tender-radar", occurredAt: "2026-08-12T00:00:00Z", dryRun: false, declaredChanged: [], items: [tender] };

  const first = run({ ...base, syncId: "sync-1", declaredAdded: [tender.reference] });
  assert.equal(first.counts.new, 1);
  const duplicate = run({ ...base, syncId: "sync-1", declaredAdded: [tender.reference] });
  assert.equal(duplicate.duplicate, true);
  const unchanged = run({ ...base, syncId: "sync-2", declaredAdded: [] });
  assert.equal(unchanged.counts.unchanged, 1);
  const changed = run({ ...base, syncId: "sync-3", declaredAdded: [], items: [{ ...tender, title: "صيانة وترميم مبنى" }] });
  assert.equal(changed.counts.changed, 1);
  assert.deepEqual(changed.changedItems[0].changedFields, ["title"]);
});

test("radar sends metadata only and exposes an automation health surface", async () => {
  const service = await readFile(new URL("../scripts/etimad-sync-service.mjs", import.meta.url), "utf8");
  const payloadFunction = service.slice(service.indexOf("function toAutomationTender"), service.indexOf("async function loadAutomationStatus"));
  assert.match(payloadFunction, /reference/);
  assert.match(payloadFunction, /etimadUrl/);
  assert.doesNotMatch(payloadFunction, /files|attachments|booklet|boq|conditions/i);
  assert.match(service, /\/automation\/status/);
  assert.match(service, /\/automation\/test/);
  assert.match(service, /N8N_RADAR_WEBHOOK_URL/);
});
