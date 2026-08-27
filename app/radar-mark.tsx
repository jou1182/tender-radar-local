// شعار رادار محلي متجدد — نسخة خفيفة من شعار التحميل الأصلي.
// استخدم حجمًا معدول حسب الإعداد حتى يناسب أحجم الشاشات.
export function RadarMark({ size = 80, animate = true }: { size?: number; animate?: boolean }) {
  return (
    <div
      className={`radar-mark ${animate ? "radar-mark-animated" : ""}`}
      style={{ width: size, height: size, fontSize: `${size * 0.38}px` }}
      role="img"
      aria-label="شعار رادار المنافسات"
    >
      <span className="radar-sweep" />
      <i className="radar-core">ر</i>
      <i className="radar-ring ring-one" />
      <i className="radar-ring ring-two" />
    </div>
  );
}
