// اختبارات P5-D0 — مخطط n8n الليلي: بنية سليمة، loopback حصرًا، بلا أسرار أو AI
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = JSON.parse(
  await readFile(new URL("../workflows/p5-daily-pipeline.json", import.meta.url), "utf8"),
);

test("P5-D0-1: workflow is valid, inactive by default, with a 02:00 cron", () => {
  assert.equal(workflow.active, false);
  const schedule = workflow.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
  assert.ok(schedule, "schedule trigger exists");
  const expression = schedule.parameters?.rule?.interval?.[0]?.expression;
  assert.equal(expression, "0 2 * * *");
});

test("P5-D0-2: every http node targets loopback only", () => {
  const httpNodes = workflow.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  assert.ok(httpNodes.length >= 2);
  for (const node of httpNodes) {
    const url = String(node.parameters?.url || "");
    assert.match(url, /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//, `loopback only: ${url}`);
  }
});

test("P5-D0-3: no secrets, credentials, ai nodes, or external hosts anywhere in the file", () => {
  const text = JSON.stringify(workflow);
  assert.doesNotMatch(text, /api[_-]?key|bearer|authorization|password/i);
  assert.doesNotMatch(text, /n8n-nodes-base\.openAi|@n8n\/n8n-nodes-langchain/i);
  assert.doesNotMatch(text, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
});

test("P5-D0-4: pipeline order is sync -> agents -> summarize and connections are wired", () => {
  const names = workflow.nodes.map((n) => n.name);
  for (const expected of ["جدولة ليلية 02:00", "بدء جولة المزامنة (loopback)", "تلخيص اليوم"]) {
    assert.ok(names.includes(expected), `missing node: ${expected}`);
  }
  const syncConn = workflow.connections["جدولة ليلية 02:00"]?.main?.[0]?.[0];
  assert.equal(syncConn?.node, "بدء جولة المزامنة (loopback)");
});
