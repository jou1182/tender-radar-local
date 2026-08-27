// P5-SHELL — شريط الحالة العلوي الرفيع: حالة الخدمة + آخر مزامنة + زر مزامنة سريع
// حاضر في كل الأقسام. عند توقف الخدمة ينطق التعليمات بدل شرائح التشغيل المبعثرة.
type Props = {
  helperOnline: boolean;
  lastSyncAt: string | null;
  isSyncing: boolean;
  syncState: "fresh" | "stale" | "pending";
  onRequestSync: () => void;
};

function fmtLastSync(iso: string | null): string {
  if (!iso) return "لم تكتمل مزامنة حقيقية بعد";
  try {
    const d = new Date(iso);
    const minutes = Math.round((Date.now() - d.getTime()) / 60000);
    const ago = minutes < 60 ? `قبل ${minutes} دقيقة` : minutes < 1440 ? `قبل ${Math.round(minutes / 60)} ساعة` : `قبل ${Math.round(minutes / 1440)} يوم`;
    return `آخر مزامنة: ${d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" })} (${ago})`;
  } catch { return "آخر مزامنة: —"; }
}

export function StatusBar({ helperOnline, lastSyncAt, isSyncing, syncState, onRequestSync }: Props) {
  return (
    <div className="status-bar" role="status">
      <span className={`status-dot ${helperOnline ? "online" : "offline"}`} />
      <span className="status-text">{helperOnline ? "الخدمة المحلية متصلة" : "الخدمة متوقفة — شغّل تشغيل-الرادار.cmd"}</span>
      <span className="status-sep">|</span>
      <span className="status-text">{fmtLastSync(lastSyncAt)}</span>
      <span className="status-sep">|</span>
      <span className={`status-syncstate ${syncState}`}>{syncState === "fresh" ? "البيانات حديثة" : syncState === "pending" ? "المزامنة تعمل" : "تحتاج مزامنة"}</span>
      <span className="status-grow" />
      <button type="button" className="status-sync-btn" disabled={isSyncing || !helperOnline} onClick={onRequestSync}>
        {isSyncing ? "جارٍ الفحص…" : "⟳ مزامنة الآن"}
      </button>
    </div>
  );
}
