import { useState, type ReactNode } from "react";
import { uiText, useUiLanguage } from "../lib/appSettings";

export type ReportDisplayStyle = "classic" | "quick" | "modern" | "erp";

const REPORT_STYLES: { value: ReportDisplayStyle; labelAr: string; labelEn: string }[] = [
  { value: "classic", labelAr: "تقليدي", labelEn: "Classic" },
  { value: "quick", labelAr: "عرض سريع", labelEn: "Compact" },
  { value: "modern", labelAr: "حديث", labelEn: "Modern" },
  { value: "erp", labelAr: "ERP مكثف", labelEn: "Dense ERP" },
];

const STYLE = `
  .zreport-display-control{display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin:0 0 10px}
  .zreport-display-control label{font-size:12px;font-weight:700;color:#475569}
  .zreport-display-control select{min-width:150px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#172033;font:inherit}
  .zreport-display[data-layout="quick"] .z-admin-table thead th{padding:6px 8px!important;font-size:11px!important;background:#e8f3eb!important}
  .zreport-display[data-layout="quick"] .z-admin-table tbody td{padding:6px 8px!important;font-size:12px!important}
  .zreport-display[data-layout="quick"] .z-admin-table tbody tr:nth-child(even){background:#f4faf5}
  .zreport-display[data-layout="modern"] .z-admin-table{border-spacing:0 2px;border-collapse:separate}
  .zreport-display[data-layout="modern"] .z-admin-table thead th{padding:11px 12px!important;background:#fff7ed!important;color:#9a3412!important;border-bottom:2px solid #fed7aa!important}
  .zreport-display[data-layout="modern"] .z-admin-table tbody tr:nth-child(even){background:#fffaf5}
  .zreport-display[data-layout="modern"] .z-admin-table tbody td{border-bottom-color:#f1e8df}
  .zreport-display[data-layout="erp"] .z-admin-table thead th{padding:6px 8px!important;background:#294477!important;color:#fff!important;font-size:11px!important}
  .zreport-display[data-layout="erp"] .z-admin-table tbody td{padding:6px 8px!important;font-size:11px!important}
  .zreport-display[data-layout="erp"] .z-admin-table tbody tr:nth-child(even){background:#eef2f8}
  .zreport-display[data-layout="erp"] .z-admin-table tbody tr:hover>td{background:#e0e8f4}
`;

function readStyle(reportKey: string): ReportDisplayStyle {
  if (typeof window === "undefined") return "classic";
  try {
    const saved = localStorage.getItem(`pos_desktop_report_layout_${reportKey}`);
    return REPORT_STYLES.some((style) => style.value === saved)
      ? saved as ReportDisplayStyle
      : "classic";
  } catch {
    return "classic";
  }
}

/** Four reusable on-screen report layouts, saved separately for each report. */
export function ReportDisplayLayout({ reportKey, children }: {
  reportKey: string;
  children: ReactNode;
}) {
  const language = useUiLanguage();
  const [layout, setLayout] = useState<ReportDisplayStyle>(() => readStyle(reportKey));

  function chooseStyle(value: string) {
    const next = REPORT_STYLES.find((style) => style.value === value)?.value;
    if (!next) return;
    setLayout(next);
    try { localStorage.setItem(`pos_desktop_report_layout_${reportKey}`, next); } catch { /* unavailable */ }
  }

  return (
    <>
      <style>{STYLE}</style>
      <section className="zreport-display" data-layout={layout} data-testid={`report-layout-${reportKey}`}>
        <div className="zreport-display-control">
          <label htmlFor={`report-layout-select-${reportKey}`}>
            {uiText("نموذج عرض التقرير", "Report display style", language)}
          </label>
          <select
            id={`report-layout-select-${reportKey}`}
            data-testid={`input-report-layout-${reportKey}`}
            value={layout}
            onChange={(event) => chooseStyle(event.target.value)}
          >
            {REPORT_STYLES.map((style) => (
              <option key={style.value} value={style.value}>
                {uiText(style.labelAr, style.labelEn, language)}
              </option>
            ))}
          </select>
        </div>
        {children}
      </section>
    </>
  );
}
