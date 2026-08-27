// P5-DASH — قسم «رؤى الجولة والتخزين»: ملخص آخر مزامنة، رسم مناطق، إدارة مرفقات.
// كل البيانات من endpoints القراءة؛ المسح الفعلي يتطلب تأكيدًا صريحًا (confirm).
import { useCallback, useEffect, useState } from "react";

const SYNC_BASE = "http://127.0.0.1:4318";

type LastRun = {
  available: boolean; message?: string;
  startedAt: string; finishedAt: string; durationLabel: string | null;
  status: string; regionsTargeted: number; regionsCompleted: number;
  checked: number; newCount: number; changedCount: number; errorMessage: string | null;
  complete: boolean; topRegions: { name: string; checked: number }[];
};
type Regions = { single: { region: string; count: number }[]; multiGroups: number; multiTenders: number; total: number };
type Storage = { files: { tenderReference: string; name: string; path: string; sizeBytes: number; modifiedAt: string | null }[]; count: number; totalBytes: number };

function fmtBytes(bytes: number): string {
  if (!bytes) return "0 بايت";
  const units = ["بايت", "كيلوبايت", "ميجابايت", "جيجابايت"];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function fmtDateAr(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("ar-SA", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

function timeAgoAr(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  return `قبل ${Math.round(hours / 24)} يوم`;
}

export function InsightsPanel() {
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [regions, setRegions] = useState<Regions | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [purgePreview, setPurgePreview] = useState<{ deleted: number; freedBytes: number } | null>(null);
  const [purgeDays, setPurgeDays] = useState(30);
  const [purgeMessage, setPurgeMessage] = useState("");
  const [showFiles, setShowFiles] = useState(false);

  const load = useCallback(async () => {
    try {
      const [run, reg, stor] = await Promise.all([
        fetch(`${SYNC_BASE}/dashboard/last-run`).then((r) => r.json()),
        fetch(`${SYNC_BASE}/dashboard/regions`).then((r) => r.json()),
        fetch(`${SYNC_BASE}/dashboard/storage`).then((r) => r.json()),
      ]);
      setLastRun(run); setRegions(reg); setStorage(stor);
    } catch { /* الخدمة غير متاحة — القسم يختفي بهدوء */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function previewPurge() {
    setPurgeMessage("");
    const res = await fetch(`${SYNC_BASE}/dashboard/storage/purge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: purgeDays }),
    });
    const data = await res.json();
    setPurgePreview({ deleted: data.wouldDelete ?? 0, freedBytes: data.freedBytes ?? 0 });
  }

  async function confirmPurge() {
    const res = await fetch(`${SYNC_BASE}/dashboard/storage/purge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: purgeDays, confirm: true }),
    });
    const data = await res.json();
    setPurgeMessage(data.deleted > 0
      ? `تم حذف ${data.deleted} ملفًا وتحرير ${fmtBytes(data.freedBytes)} ✓`
      : "لا توجد ملفات ضمن هذا العمر.");
    setPurgePreview(null);
    void load();
  }

  if (!lastRun || !regions) return null;
  const maxCount = Math.max(...regions.single.map((r) => r.count), 1);

  return (
    <section className="insights-panel" aria-label="رؤى الجولة والتخزين">
      <div className="insights-head">
        <div>
          <p className="eyebrow">آخر جولة مزامنة</p>
          <h2>رؤى الجولة والتخزين</h2>
        </div>
        {lastRun.available && <span className={`team-state ${lastRun.complete ? "" : "busy"}`}>{lastRun.complete ? "✓ اكتملت بنجاح" : "أُوقفت في المنتصف"}</span>}
      </div>

      {!lastRun.available && <p className="insights-empty">{lastRun.message}</p>}

      {lastRun.available && (
        <>
          <div className="insights-summary">
            <table className="summary-table">
              <tbody>
                <tr><th>بدأت</th><td>{fmtDateAr(lastRun.startedAt)} <small>({timeAgoAr(lastRun.startedAt)})</small></td></tr>
                <tr><th>انتهت</th><td>{fmtDateAr(lastRun.finishedAt)}</td></tr>
                <tr><th>المدة</th><td>{lastRun.durationLabel ?? "—"}</td></tr>
                <tr><th>الحالة</th><td>{lastRun.complete ? `اكتملت بنجاح — ${lastRun.regionsCompleted}/${lastRun.regionsTargeted} منطقة، بلا أي خطأ` : `${lastRun.regionsCompleted}/${lastRun.regionsTargeted} منطقة${lastRun.errorMessage ? ` · ${lastRun.errorMessage}` : ""}`}</td></tr>
                <tr><th>النتيجة</th><td><b className="new-count">🆕 {lastRun.newCount} جديدة</b> · <b className="changed-count">🔁 {lastRun.changedCount} متغيرة</b> · {lastRun.checked} ظهورًا مفحوصًا</td></tr>
                {lastRun.topRegions.length > 0 && (
                  <tr><th>الأكثر فحصًا</th><td>{lastRun.topRegions.map((r) => `${r.name} (${r.checked})`).join(" · ")}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {regions.single.length > 0 && (
            <div className="insights-chart">
              <p className="insights-chart-title">المنافسات المخزنة حسب المنطقة <small>({regions.total} منافسة · منها {regions.multiTenders} متعددة المناطق في {regions.multiGroups} مجموعة)</small></p>
              <div className="region-bars">
                {regions.single.map((r) => (
                  <div key={r.region} className="region-row" title={`${r.region}: ${r.count}`}>
                    <span className="region-name">{r.region.includes("القصيم") ? `⭐ ${r.region}` : r.region}</span>
                    <div className="region-track"><div className="region-fill" style={{ width: `${Math.max(4, (r.count / maxCount) * 100)}%` }} /></div>
                    <span className="region-count">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="insights-storage">
            <div className="storage-head">
              <b>🗄️ ملفات التنزيل</b>
              <span>{storage.count} ملفًا · {fmtBytes(storage.totalBytes)}</span>
              <button type="button" className="quiet" onClick={() => setShowFiles(!showFiles)}>{showFiles ? "إخفاء القائمة" : "استعراض الملفات"}</button>
            </div>
            {showFiles && (
              <ul className="storage-files">
                {storage.files.length === 0 && <li className="storage-empty">لا توجد ملفات منزّلة بعد — أول تنزيل حي يتطلب موافقتك.</li>}
                {storage.files.map((f) => (
                  <li key={f.path}>
                    <b>{f.name}</b>
                    <small>منافسة {f.tenderReference} · {fmtBytes(f.sizeBytes)} · {fmtDateAr(f.modifiedAt)}</small>
                    <code dir="ltr">{f.path}</code>
                  </li>
                ))}
              </ul>
            )}
            <div className="storage-purge">
              <b>🧹 التنظيف التلقائي</b>
              <span>حذف المرفقات الأقدم من</span>
              <select value={purgeDays} onChange={(e) => { setPurgeDays(Number(e.target.value)); setPurgePreview(null); setPurgeMessage(""); }}>
                <option value={7}>7 أيام</option>
                <option value={14}>14 يومًا</option>
                <option value={30}>30 يومًا (موصى به)</option>
                <option value={60}>60 يومًا</option>
                <option value={90}>90 يومًا</option>
              </select>
              <div className="inline-row">
                <button type="button" className="outline-button" onClick={() => void previewPurge()}>معاينة المسح</button>
                {purgePreview && purgePreview.deleted > 0 && (
                  <button type="button" className="danger-button" onClick={() => void confirmPurge()}>
                    تأكيد حذف {purgePreview.deleted} ملفًا ({fmtBytes(purgePreview.freedBytes)})
                  </button>
                )}
              </div>
              {purgePreview && <small className="panel-msg">المعاينة: سيُحذف {purgePreview.deleted} ملفًا ويُحرَّر {fmtBytes(purgePreview.freedBytes)}.</small>}
              {purgeMessage && <em className="panel-msg">{purgeMessage}</em>}
              <small className="storage-note">المسح لا يمسّ بيانات المنافسات في القاعدة — يفرغ مسارات الملفات فقط. يُسجَّل في نشاط الوكيل عبدالله.</small>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
