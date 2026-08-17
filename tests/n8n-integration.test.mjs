import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../automation/n8n/radar-phase-1.workflow.json", import.meta.url);
const analysisWorkflowUrl = new URL("../workflows/p4a-local-analysis.json", import.meta.url);

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

test("n8n p4a local analysis workflow is active, loopback-only, and contains no AI or file nodes", async () => {
  const workflow = JSON.parse(await readFile(analysisWorkflowUrl, "utf8"));
  const types = workflow.nodes.map((node) => node.type);
  assert.equal(workflow.active, true, "the analysis workflow is active");
  const allowed = [
    "n8n-nodes-base.webhook",
    "n8n-nodes-base.if",
    "n8n-nodes-base.httpRequest",
    "n8n-nodes-base.respondToWebhook",
  ];
  assert.ok(types.every((type) => allowed.includes(type)), `only webhook/if/httpRequest/respondToWebhook allowed, got: ${types.join(",")}`);
  assert.ok(types.includes("n8n-nodes-base.webhook"));
  assert.ok(types.includes("n8n-nodes-base.if"));
  assert.ok(types.includes("n8n-nodes-base.httpRequest"));
  assert.ok(types.includes("n8n-nodes-base.respondToWebhook"));
  assert.ok(!types.some((type) => /langchain|ollama|openai|readWriteFile|extractFromFile/i.test(type)));
  const http = workflow.nodes.find((node) => node.type === "n8n-nodes-base.httpRequest");
  assert.ok(http, "httpRequest node exists");
  const url = http.parameters.url;
  assert.match(url, /^=http:\/\/127\.0\.0\.1:\d+\//, "httpRequest targets http://127.0.0.1:<port>/ exclusively");
  const host = (url.match(/^=http:\/\/([^/]+)\//) || [])[1];
  assert.equal(host, "127.0.0.1:4318", "the loopback host is exactly 127.0.0.1:4318");
  // explicit rejection of any other host anywhere in the workflow JSON
  const allHosts = [...JSON.stringify(workflow).matchAll(/https?:\/\/([^/$\s"']+)/g)].map((m) => m[1]);
  assert.ok(allHosts.length > 0, "the workflow contains http URLs");
  assert.ok(allHosts.every((h) => h.startsWith("127.0.0.1")), `every workflow URL is loopback-only, got: ${allHosts.join(",")}`);
  const raw = await readFile(analysisWorkflowUrl, "utf8");
  assert.doesNotMatch(raw, /password|secret|api[_-]?key|token|authorization|cookie|otp/i, "no secrets inside any node");
  const ifNode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.if");
  assert.ok(ifNode, "if node exists");
  assert.equal(ifNode.parameters.conditions.combinator, "and");
  const condition = ifNode.parameters.conditions.conditions[0];
  assert.equal(condition.leftValue, "={{ $json.body.analysisJobId }}");
  assert.equal(condition.rightValue, "");
  assert.equal(condition.operator.type, "string");
  assert.equal(condition.operator.operation, "notEmpty");
});

test("n8n p4a local analysis if-node requires a non-empty analysisJobId", async () => {
  const workflow = JSON.parse(await readFile(analysisWorkflowUrl, "utf8"));
  const ifNode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.if");
  const condition = ifNode.parameters.conditions.conditions[0];
  // Evaluate the n8n "string/notEmpty" condition for sample payloads, same extraction style as phase-1.
  const evaluate = (body) => {
    const left = String(body?.analysisJobId ?? "");
    if (condition.operator.operation === "notEmpty") return left.length > 0;
    return left === String(condition.rightValue ?? "");
  };
  assert.equal(evaluate({ analysisJobId: "analysis-job-123" }), true, "a non-empty analysisJobId passes");
  assert.equal(evaluate({ analysisJobId: " " }), true, "whitespace-only is non-empty");
  assert.equal(evaluate({ analysisJobId: "" }), false, "empty analysisJobId fails");
  assert.equal(evaluate({ analysisJobId: null }), false, "null analysisJobId fails");
  assert.equal(evaluate({}), false, "absent analysisJobId fails");
  const respondInvalid = workflow.nodes.find((node) => node.name === "رفض المدخل الناقص");
  assert.match(respondInvalid.parameters.responseBody, /INVALID_INPUT/, "the invalid branch replies INVALID_INPUT");
  const respondSuccess = workflow.nodes.find((node) => node.name === "تسجيل النجاح");
  assert.match(respondSuccess.parameters.responseBody, /jobStatus/, "the success branch reports jobStatus");
});
