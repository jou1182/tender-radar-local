import test from "node:test";
import assert from "node:assert/strict";
import { waitForSettledTenderPage, isDetailsForSupplierUrl } from "../scripts/lib/etimad-live-driver.mjs";

// يحاكي تسلسل إعادة توجيه اعتماد: Details (وسيطة) → DetailsForSupplier (نهائية).
// getState يُرجع حالة متتالية في كل استدعاء، ويراقب عدد الاستدعاءات.

function makeRedirectSimulator() {
  const DETAILS = "https://tenders.etimad.sa/Tender/Details?STenderId=lWXQuT9gLPq6bzpS1YoWzw==";
  const SUPPLIER = "https://tenders.etimad.sa/Tender/DetailsForSupplier?STenderId=lWXQuT9gLPq6bzpS1YoWzw%3D%3D";
  // التسلسل الزمني: 3 استدعاءات على الصفحة الوسيطة (readyState=complete في الأخيرة منها
  // — وهو الفخ القديم)، ثم إعادة توجيه لـ DetailsForSupplier ثم استقرارها.
  const states = [
    { url: DETAILS, readyState: "loading" },
    { url: DETAILS, readyState: "loading" },
    { url: DETAILS, readyState: "complete" },   // ← الصفحة الوسيطة "جاهزة" لكنها ليست النهائية
    { url: SUPPLIER, readyState: "loading" },
    { url: SUPPLIER, readyState: "complete" },
    { url: SUPPLIER, readyState: "complete" },
  ];
  let calls = 0;
  return {
    states,
    getState: async () => {
      const s = states[Math.min(calls, states.length - 1)];
      calls += 1;
      return { ...s };
    },
    callCount: () => calls,
  };
}

test("redirect: ينتظر DetailsForSupplier المستقرة ولا يقبل Details الوسيطة المكتملة", async () => {
  const sim = makeRedirectSimulator();
  const result = await waitForSettledTenderPage({
    getState: sim.getState,
    sleepFn: async () => {}, // لا ننتظر فعليًا في الاختبار
    pollMs: 0,
    stability: 2,
  });
  assert.equal(isDetailsForSupplierUrl(result.url), true, "يجب أن يستقر على DetailsForSupplier");
  // يجب أن يكون قد تجاوز الصفحة الوسيطة (أول 3 استدعاءات) وأكمل الاستقرار
  assert.ok(sim.callCount() >= 5, `استدعاءات كثيرة كافية لعبور الوسيطة (كانت ${sim.callCount()})`);
});

test("redirect: يُسلّم حالة سكون DetailsForSupplier فورًا دون انتظار زائد", async () => {
  const SUPPLIER = "https://tenders.etimad.sa/Tender/DetailsForSupplier?STenderId=x%3D%3D";
  let calls = 0;
  const result = await waitForSettledTenderPage({
    getState: async () => { calls += 1; return { url: SUPPLIER, readyState: "complete" }; },
    sleepFn: async () => {},
    pollMs: 0,
    stability: 2,
  });
  assert.equal(result.url, SUPPLIER);
  assert.equal(calls, 2, "استقرار بعينتين متطابقتين فقط");
});

test("redirect: يعيد توجيهه حتى لو ظهر Details (بدون ForSupplier) مكتملًا أولًا", async () => {
  // حالة أصعب: الصفحة الوسيطة نفسها تُعلن complete، ثم تعود Details أخرى، ثم ForSupplier
  const DETAILS = "https://tenders.etimad.sa/Tender/Details?STenderId=a==";
  const SUPPLIER = "https://tenders.etimad.sa/Tender/DetailsForSupplier?STenderId=a%3D%3D";
  const seq = [
    { url: DETAILS, readyState: "complete" },
    { url: DETAILS, readyState: "complete" },
    { url: SUPPLIER, readyState: "complete" },
    { url: SUPPLIER, readyState: "complete" },
  ];
  let i = 0;
  const result = await waitForSettledTenderPage({
    getState: async () => seq[Math.min(i++, seq.length - 1)],
    sleepFn: async () => {},
    pollMs: 0,
    stability: 2,
  });
  assert.equal(isDetailsForSupplierUrl(result.url), true);
});

test("redirect: المهلة تُرمى عند غياب DetailsForSupplier", async () => {
  const DETAILS = "https://tenders.etimad.sa/Tender/Details?STenderId=z==";
  await assert.rejects(
    () => waitForSettledTenderPage({
      getState: async () => ({ url: DETAILS, readyState: "complete" }),
      sleepFn: async () => {},
      pollMs: 0,
      deadlineMs: 5,
    }),
    /لم تستقر/,
    "يجب أن يفشل بالمهلة إن لم تظهر DetailsForSupplier",
  );
});
