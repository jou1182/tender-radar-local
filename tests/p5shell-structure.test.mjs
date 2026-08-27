// اختبارات P5-SHELL — الهيكل التجاري: قائمة جانبية يمين + شريط حالة + 6 أقسام
import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

test("P5-SHELL-1: page declares the flex RTL shell (sidebar first in DOM = right side)", async () => {
  const src = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(src, /className="app-shell"/);
  assert.match(src, /dir="rtl"/);
  assert.ok(src.indexOf("app-sidebar") < src.indexOf("app-main"), "sidebar must precede main (RTL right side)");
  assert.match(src, /className="app-main"/);
});

test("P5-SHELL-2: page declares the six sections in the mandated order with tenders default", async () => {
  const src = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const order = ["tenders", "smart-search", "dashboard", "agents", "ops", "storage"];
  let prev = -1;
  for (const id of order) {
    const i = src.indexOf(`id: "${id}"`);
    assert.ok(i !== -1, `section ${id} missing`);
    assert.ok(i > prev, `section ${id} out of order`);
    prev = i;
  }
  assert.match(src, /useState[^;]*"tenders"/);
});

test("P5-SHELL-3: status bar component exists and shows service, last sync, and sync button", async () => {
  const src = await readFile(new URL("../app/status-bar.tsx", import.meta.url), "utf8");
  assert.match(src, /export function StatusBar/);
  assert.match(src, /helperOnline/);
  assert.match(src, /lastSyncAt/);
  assert.match(src, /مزامنة الآن/);
});

test("P5-SHELL-4: sections are hidden via display, not unmounted (filters persist)", async () => {
  const src = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(src, /display: activeSection === section\.id \? "block" : "none"/);
  // الشاشة الطويلة القديمة حُذفت: لا hero ولا flow مباشرة تحت الجذر
  assert.ok(!/<section className="hero">/.test(src), "old hero removed");
  assert.ok(!/<section className="flow">/.test(src), "old flow removed");
});

test("P5-SHELL-5: smart search exists with deterministic parser + chips", async () => {
  const src = await readFile(new URL("../app/smart-search.tsx", import.meta.url), "utf8");
  assert.match(src, /export function SmartSearch/);
  assert.match(src, /chips/);
  // مرجع 12 رقمًا → قفزة مباشرة (نمط \d{12})
  assert.match(src, /d\{12\}/);
  // كلمات مجاني/مدفوع
  assert.match(src, /مجاني/);
});

test("P5-SHELL-6: region donut chart exists as pure SVG", async () => {
  const src = await readFile(new URL("../app/region-donut.tsx", import.meta.url), "utf8");
  assert.match(src, /export function RegionDonut/);
  assert.match(src, /stroke-dasharray|strokeDasharray/);
  assert.ok(!/from "/.test(src.replace(/from "react"/, "")), "donut must be dependency-free");
});

test("P5-SHELL-7: agent management uses tabbed control panel", async () => {
  const src = await readFile(new URL("../app/agent-management.tsx", import.meta.url), "utf8");
  assert.match(src, /activeTab/);
  assert.match(src, /management-tab/);
});

test("P5-SHELL-8: font scale raised and Tajawal kept", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /Tajawal/);
  assert.match(css, /app-shell \{ display: flex; min-height: 100vh; font-size: 1rem; \}/);
  assert.match(css, /app-shell table \{ font-size: \.98rem; \}/);
});
