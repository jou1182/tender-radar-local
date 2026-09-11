import test from "node:test";
import assert from "node:assert/strict";
import { isBusyPhase, isServiceBusy, computeVariableIntervalSeconds } from "../scripts/lib/session-keepalive.mjs";

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

test("P5-KEEPALIVE: فترة النبضة متغيرة عشوائيًا بحدود 5 دقائق (غير ثابتة)", () => {
  // 1. حالات محددة بدقة تثبت متطلبات المالك:
  // أدنى حد: دقيقة واحدة (60 ثانية)
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 60, maxSeconds: 300, stepSeconds: 15, random: () => 0 }), 60);
  // دقيقة ونصف (90 ثانية)
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 60, maxSeconds: 300, stepSeconds: 15, random: () => 0.125 }), 90);
  // 4 دقائق (240 ثانية)
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 60, maxSeconds: 300, stepSeconds: 15, random: () => 0.75 }), 240);
  // أقصى حد: 5 دقائق (300 ثانية)
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 60, maxSeconds: 300, stepSeconds: 15, random: () => 0.999 }), 300);

  // 2. الحماية والحدود الآمنة
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 10, maxSeconds: 500, random: () => 0 }), 30, "لا تقل عن 30ث");
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 10, maxSeconds: 500, random: () => 0.999 }), 300, "لا تزيد عن 300ث");
  assert.equal(computeVariableIntervalSeconds({ minSeconds: 120, maxSeconds: 120 }), 120, "تطابق الحدود");

  // 3. اختبار التباين وعدم الثبات (عينة إحصائية)
  const samples = Array.from({ length: 50 }, () => computeVariableIntervalSeconds({ minSeconds: 60, maxSeconds: 300 }));
  for (const s of samples) {
    assert.ok(s >= 60 && s <= 300, `القيمة ${s} خارج نطاق [60, 300]`);
    assert.equal(s % 15, 0, `القيمة ${s} يجب أن تكون بمضاعفات 15 ثانية`);
  }
  const unique = new Set(samples);
  assert.ok(unique.size > 3, "القيم متغيرة بالفعل وليست ثابتة");
});
