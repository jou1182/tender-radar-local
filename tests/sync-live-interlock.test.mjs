// P5-GAPFIX-SYNC-LIVE-INTERLOCK — اختبار معزول (بلا شبكة/Chrome/أدوات) لقفل
// التشابك المتبادل بين المزامنة والتنزيل الحي داخل خدمة اعتماد.
// لا يفتح قاعدة تشغيل ولا يلامس أي ملف حقيقي — تحليل نصي لحارسَي الخدمة.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const servicePath = new URL("../scripts/etimad-sync-service.mjs", import.meta.url);
const source = readFileSync(servicePath, "utf8");

test("P5-SYNCLIVE-1: /sync يُرفض أثناء تنزيل حي جارٍ بكود صريح", () => {
  // حارس مزامنة→تنزيل: لا تبدأ مزامنة بينما liveDownloading === true
  assert.match(source, /liveDownloading/, "علم التنزيل الحي موجود في الخدمة");
  const guard = source.slice(source.indexOf('request.url === "/sync"'), source.indexOf("P4-A0: نقاط التحليل المحلي"));
  assert.match(guard, /if \(liveDownloading\)/, "مسار /sync يفحص علم التنزيل الحي قبل بدء المزامنة");
  assert.match(guard, /SYNC_BLOCKED_BY_LIVE_DOWNLOAD/, "يُرفض بكود صريح يمكن للواجهة التعامل معه");
  assert.match(guard, /409/, "رمز الحالة 409 (تعارض — أعد لاحقًا)");
});

test("P5-SYNCLIVE-2: التنزيل الحي يُرفض أثناء مزامنة نشطة بكود صريح", () => {
  // حارس تنزيل→مزامنة: لا تبدأ تنزيلًا حيًا بينما syncPromise قيد التشغيل
  const guard = source.slice(source.indexOf('pathname === "/approval-jobs/live"'), source.indexOf("request.url === \"/sync\""));
  assert.match(guard, /if \(syncPromise\)/, "مسار التنزيل الحي يفحص علم المزامنة قبل التنفيذ");
  assert.match(guard, /LIVE_DOWNLOAD_BLOCKED_BY_SYNC/, "يُرفض بكود صريح يمكن للواجهة التعامل معه");
  assert.match(guard, /409/, "رمز الحالة 409 (تعارض — أعد لاحقًا)");
});

test("P5-SYNCLIVE-3: /status يكشف علمَي الانشغال (downloading وsyncing)", () => {
  // النبضة ولوحة القيادة تتخذان قرارهما من /status — يجب أن يظهر العلمان معًا.
  assert.match(source, /downloading: liveDownloading/, "/status يكشف downloading");
  assert.match(source, /syncing: syncPromise/, "/status يكشف syncing (مزامنة جارية)");
});