import test from "node:test";
import assert from "node:assert/strict";
import { isBusyPhase, isServiceBusy } from "../scripts/lib/session-keepalive.mjs";

test("P5-KEEPALIVE: قفل التشابك يمنع النبضة أثناء المزامنة/التنزيل", () => {
  // أثناء نشاط حقيقي — يجب أن تتوقف النبضة
  for (const phase of ["starting", "scanning", "resuming", "captcha-required", "login-required"]) {
    assert.equal(isBusyPhase(phase), true, `${phase} يجب أن يوقف النبضة`);
  }
  // في السكون — يجب أن تعمل النبضة
  for (const phase of ["idle", "complete", "error", null, undefined, ""]) {
    assert.equal(isBusyPhase(phase), false, `${phase} يجب أن يسمح بالنبضة`);
  }
});

test("P5-KEEPALIVE: التنزيل الحي الجاري يوقف النبضة (علم downloading)", () => {
  // تنزيل حي جارٍ حتى لو phase=idle — يجب أن يتوقف
  assert.equal(isServiceBusy({ phase: "idle", downloading: true }), true, "تنزيل حي = انشغال");
  // سكون تام — النبضة تعمل
  assert.equal(isServiceBusy({ phase: "idle", downloading: false }), false, "بلا تنزيل وبلا مزامنة = سكون");
  // undefined downloading يُعامل كـfalse
  assert.equal(isServiceBusy({ phase: "idle" }), false);
});
