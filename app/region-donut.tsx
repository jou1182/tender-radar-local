// P5-SHELL — رسم دائري Donut نقي SVG بلا أي مكتبة: 13 منطقة، القصيم بلون مميز.
// مدخل واحد: single: {region, count}[] — يرسم الحصص بمقياس stroke-dasharray.
export function RegionDonut({ data }: { data: { region: string; count: number }[] }) {
  const palette = ["#0f766e", "#14b8a6", "#2dd4bf", "#5eead4", "#99f6e4", "#0d9488", "#115e59", "#134e4a", "#042f2e", "#2c7a7b", "#319795", "#38b2ac", "#4fd1c5"];
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((s, r) => s + r.count, 0) || 1;
  const R = 62;
  const C = 2 * Math.PI * R;
  const slices: { key: string; color: string; dasharray: string; offset: number; percent: number; count: number }[] = [];
  let acc = 0;
  for (const [index, row] of sorted.entries()) {
    const fraction = row.count / total;
    const dash = fraction * C;
    slices.push({
      key: row.region,
      color: row.region.includes("القصيم") ? "#f59e0b" : palette[index % palette.length],
      dasharray: `${dash - 1.5} ${C - dash + 1.5}`,
      offset: -acc,
      percent: Math.round(fraction * 100),
      count: row.count,
    });
    acc += dash;
  }

  return (
    <div className="region-donut">
      <svg viewBox="0 0 160 160" role="img" aria-label="توزيع المنافسات حسب المنطقة">
        <g transform="rotate(-90 80 80)">
          {slices.map((s) => (
            <circle
              key={s.key}
              cx="80" cy="80" r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="18"
              strokeDasharray={s.dasharray}
              strokeDashoffset={s.offset}
            />
          ))}
        </g>
        <text x="80" y="75" textAnchor="middle" className="donut-total">{total}</text>
        <text x="80" y="93" textAnchor="middle" className="donut-caption">منافسة</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.key}>
            <span className="legend-swatch" style={{ background: s.color }} />
            <span className="legend-name">{s.key.includes("القصيم") ? `⭐ ${s.key}` : s.key}</span>
            <span className="legend-count">{s.count} <small>({s.percent}%)</small></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
