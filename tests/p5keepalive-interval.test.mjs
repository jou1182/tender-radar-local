import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRadarRepository } from "../scripts/lib/radar-repository.mjs";

test("P5-KEEPALIVE: الفترة تُخزَّن وتُقرأ بحدود آمنة", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "radar-ka-"));
  try {
    const repository = await createRadarRepository({ projectRoot });

    // الافتراضي 60 ثانية
    assert.equal(repository.getKeepaliveInterval(), 60, "الافتراضي دقيقة");

    // ضبط قيمة صالحة
    const r = repository.setKeepaliveInterval(180);
    assert.equal(r.keepaliveIntervalSeconds, 180);
    assert.equal(repository.getKeepaliveInterval(), 180, "تُحفظ وتُقرأ");

    // الحدود: أقل من 30 مرفوض
    assert.throws(() => repository.setKeepaliveInterval(10), (e) => e.code === "KEEPALIVE_INTERVAL_INVALID");
    // أعلى من 300 مرفوض
    assert.throws(() => repository.setKeepaliveInterval(999), (e) => e.code === "KEEPALIVE_INTERVAL_INVALID");

    // قيمة غير رقمية
    assert.throws(() => repository.setKeepaliveInterval(Number("xyz")), (e) => e.code === "KEEPALIVE_INTERVAL_INVALID");

    if (repository.close) await repository.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});