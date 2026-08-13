export default function Loading() {
  return (
    <div className="radar-loader radar-loader-route" role="status" aria-live="polite">
      <div className="radar-loader-brand">
        <div className="radar-loader-mark">
          <span className="radar-sweep" />
          <i className="radar-core">ر</i>
          <i className="radar-ring ring-one" />
          <i className="radar-ring ring-two" />
        </div>
        <div><b>رادار المنافسات</b><small>نقرأ الإشارة قبل القرار</small></div>
      </div>
      <div className="radar-loader-progress"><span /><span /><span /><span /></div>
      <p>جاري تجهيز أحدث بيانات الرادار…</p>
    </div>
  );
}
