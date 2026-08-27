// P5-SHELL — هيكل المنصة التجاري: قائمة جانبية يمين (RTL flex) + 6 أقسام تُخفى لا تُفكك.
// الأقسام تبقى موصولة حالةً (فلاتر البحث لا تضيع عند التنقل) عبر إخفاء display.
import { useState, type ReactNode } from "react";
import { RadarMark } from "./radar-mark";

export type SectionId = "tenders" | "smart-search" | "dashboard" | "agents" | "ops" | "storage";

const SECTIONS: { id: SectionId; icon: string; label: string }[] = [
  { id: "tenders", icon: "📋", label: "المنافسات" },
  { id: "smart-search", icon: "🔍", label: "البحث الذكي" },
  { id: "dashboard", icon: "📊", label: "لوحة القيادة" },
  { id: "agents", icon: "🤖", label: "فريق الوكلاء" },
  { id: "ops", icon: "🔄", label: "التشغيل" },
  { id: "storage", icon: "🗄️", label: "التخزين" },
];

type ShellProps = {
  statusBar: ReactNode;
  sections: Record<SectionId, ReactNode>;
  footerMeta?: React.ReactNode;
};

export function AppShell({ statusBar, sections, footerMeta }: ShellProps) {
  const [active, setActive] = useState<SectionId>("tenders");

  return (
    <div className="app-shell" dir="rtl">
      <aside className="app-sidebar">
        <div className="app-brand">
          <RadarMark size={40} animate />
          <div><b>رادار المنافسات</b><small>نقرأ الإشارة قبل القرار</small></div>
        </div>
        <nav className="app-nav" aria-label="أقسام المنصة">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`app-nav-btn ${active === section.id ? "active" : ""}`}
              aria-current={active === section.id ? "page" : undefined}
              onClick={() => setActive(section.id)}
            >
              <span className="app-nav-ico">{section.icon}</span>
              {section.label}
            </button>
          ))}
        </nav>
        <div className="app-side-foot">{footerMeta}</div>
      </aside>

      <main className="app-main">
        {statusBar}
        {SECTIONS.map((section) => (
          <div
            key={section.id}
            data-section={section.id}
            className="app-section"
            style={{ display: active === section.id ? "block" : "none" }}
          >
            {sections[section.id]}
          </div>
        ))}
      </main>
    </div>
  );
}
