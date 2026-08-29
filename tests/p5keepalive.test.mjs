import test from "node:test";
import assert from "node:assert/strict";
import { isBusyPhase } from "../scripts/lib/session-keepalive.mjs";

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
