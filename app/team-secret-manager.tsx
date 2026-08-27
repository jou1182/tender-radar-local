// P5-F2 — إدارة سر الفريق في الواجهة: تغيير صريح + إرشادات النسيان
// ملاحظة معمارية: كلمة السر نفسها لا تُستخرج أبدًا (بصمة scrypt فقط). التغيير يتطلب
// القديمة + الجديدة مرتين، ويُبطل جلسات التوكن الحالية بمفتاح عشوائي جديد للخدمة؟
// لا — الجلسات HMAC بذاكرة العملية وسرها عشوائي مستقل؛ تغيير سر الفريق لا يبطلها
// لذا يعيد مسار التغيير إصدار توكن جديد فورًا.
import { useCallback, useEffect, useState } from "react";

const SYNC_BASE = "http://127.0.0.1:4318";

type ChangeState = {
  open: boolean;
  current: string;
  next: string;
  confirm: string;
  error: string;
  done: string;
  busy: boolean;
};

const emptyChange: ChangeState = { open: false, current: "", next: "", confirm: "", error: "", done: "", busy: false };

export function TeamSecretManager({ onSecretChanged }: { onSecretChanged?: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [change, setChange] = useState<ChangeState>(emptyChange);
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    // القراءة داخل مؤقت: setState خارج دورة الرندر المتزامنة (قاعدة react-hooks).
    const initial = window.setTimeout(handler, 0);
    window.addEventListener("storage", handler);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const patch = useCallback((partial: Partial<ChangeState>) => {
    setChange((current) => ({ ...current, ...partial }));
  }, []);

  async function submitChange() {
    if (!change.current || !change.next) {
      patch({ error: "اكتب الكلمة الحالية والجديدة." });
      return;
    }
    if (change.next.length < 8) {
      patch({ error: "الكلمة الجديدة يجب أن تكون 8 أحرف على الأقل." });
      return;
    }
    if (change.next !== change.confirm) {
      patch({ error: "الكلمة الجديدة وتأكيدها غير متطابقين." });
      return;
    }
    patch({ busy: true, error: "" });
    try {
      const res = await fetch(`${SYNC_BASE}/agents/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          newSecret: change.next,
          currentSecret: change.current,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        patch({ busy: false, error: data.message ?? "تعذر التغيير." });
        return;
      }
      // نجاح: توكن جديد صادر تلقائيًا من الخدمة بعد التغيير
      window.sessionStorage.setItem("radar-team-token", data.token);
      setToken(data.token);
      setChange({ ...emptyChange, done: "تم تغيير كلمة سر الفريق ✓ — استخدم الجديدة في المرات القادمة." });
      onSecretChanged?.();
    } catch (error) {
      patch({ busy: false, error: String((error as Error)?.message ?? error) });
    }
  }

  return (
    <div className="team-secret-manager">
      {token && (
        <button type="button" className="quiet secret-change-toggle" onClick={() => setChange((c) => ({ ...c, open: !c.open, done: "", error: "" }))}>
          تغيير كلمة سر الفريق
        </button>
      )}
      {!token && (
        <button type="button" className="quiet secret-recovery-toggle" onClick={() => setShowRecovery((v) => !v)}>
          نسيت كلمة السر؟
        </button>
      )}

      {change.open && (
        <div className="secret-change-panel" role="dialog" aria-label="تغيير كلمة سر الفريق">
          <b>تغيير كلمة سر الفريق</b>
          <input
            type="password"
            placeholder="الكلمة الحالية (إلزامية)"
            value={change.current}
            onChange={(e) => patch({ current: e.target.value })}
            autoComplete="current-password"
          />
          <input
            type="password"
            placeholder="الكلمة الجديدة (8 أحرف+)"
            value={change.next}
            onChange={(e) => patch({ next: e.target.value })}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="تأكيد الكلمة الجديدة"
            value={change.confirm}
            onChange={(e) => patch({ confirm: e.target.value })}
            autoComplete="new-password"
          />
          {change.error && <em className="test-error">{change.error}</em>}
          {change.done && <em className="panel-msg">{change.done}</em>}
          <div className="inline-row">
            <button type="button" disabled={change.busy} onClick={() => void submitChange()}>
              {change.busy ? "جارٍ التغيير…" : "تغيير الآن"}
            </button>
            <button type="button" className="quiet" onClick={() => setChange(emptyChange)}>إلغاء</button>
          </div>
          <small>ملاحظة: التغيير يتطلب الكلمة الحالية ولا يوجد استرجاع تلقائي.</small>
        </div>
      )}

      {showRecovery && (
        <div className="secret-recovery-panel" role="note" aria-label="إرشادات استعادة كلمة السر">
          <b>نسيت كلمة السر؟ — الحقيقة الكاملة</b>
          <ul>
            <li>القاعدة تخزّن <b>بصمة تشفيرية</b> للكلمة فقط (scrypt) — <b>لا يمكن استخراجها أو إرسالها لك</b>، وهذا عن قصد.</li>
            <li>لا يوجد بريد استعادة ولا سؤال سري. هذه البوابة تحمي مفاتيح API الخاصة بالوكلاء الخارجيين.</li>
          </ul>
          <b>مسار الطوارئ (أنت مالك الجهاز):</b>
          <ol>
            <li>أغلق الرادار (نافذة المشغّل).</li>
            <li>نفّذ الأمر التالي من مجلد المشروع <code>radar</code>:</li>
          </ol>
          <pre>{`python -c "import sqlite3; c = sqlite3.connect('.radar-data/radar.sqlite'); c.execute(\\"DELETE FROM policy_settings WHERE key='teamAdminCredential'\\"); c.commit(); print('reset done')"`}</pre>
          <ol start={3}>
            <li>شغّل الرادار من جديد → ستعود الشاشة إلى حالة «أول مرة» واضبط كلمة جديدة.</li>
          </ol>
          <b>⚠️ الأثر:</b>
          <ul>
            <li>المزامنة والبيانات والوكلاء المحليون: <b>لا تتأثر إطلاقًا</b>.</li>
            <li>مفاتيح API الخارجية كانت مشفرة بالكلمة القديمة ⇒ <b>تصبح غير قابلة للفك</b> — أعد إدخالها من لوحة كل وكيل خارجي.</li>
          </ul>
          <button type="button" className="quiet" onClick={() => setShowRecovery(false)}>إغلاق</button>
        </div>
      )}
    </div>
  );
}
