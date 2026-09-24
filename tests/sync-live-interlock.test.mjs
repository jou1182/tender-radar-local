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

test("P5-SYNCLIVE-4: علم التنزيل يُرفع متزامنًا قبل أول await (لا نافذة TOCTOU)", () => {
  // المراجعة المستقلة رصدت: كان liveDownloading = true يتأخر إلى ما بعد await readJsonBody
  // (وقبلها يدخل طلب /sync من حارسه بلا تصادم). الإصلاح: رفع العلم قبل أول await
  // داخل try مفتوح قبله، مع إعادة ضبطه في finally يغطي كل المسارات.
  // فحص بنيوي على نص المسار (بنفس طبيعة زملائه هنا).
  const guard = source.slice(source.indexOf('pathname === "/approval-jobs/live"'), source.indexOf('request.url === "/sync"'));
  const posSet = guard.indexOf("liveDownloading = true;");
  const posTry = guard.indexOf("try {");
  const posRead = guard.indexOf("await readJsonBody");
  assert.ok(posSet !== -1 && posTry !== -1 && posRead !== -1, "مواقع رفع العلم وفتح try وقراءة الجسد موجودة في المسار");
  assert.ok(posSet < posRead, `رفع العلم (${posSet}) يجب أن يسبق أول await (${posRead}) — حاليًا يقع بعده`);
  assert.ok(posTry < posRead, "كتلة try مفتوحة قبل أول await لضمان تغطية finally لأخطاء ما قبل التنفيذ");
  assert.match(guard, /finally \{\s*liveDownloading = false;\s*\}/, "finally يُعيد ضبط العلم (الضمانة العكسية)");
});