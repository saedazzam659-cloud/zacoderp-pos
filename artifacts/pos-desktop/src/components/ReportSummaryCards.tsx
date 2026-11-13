import { Card, fmt } from "../pages/_adminUi";

export type ReportSummaryMetric = {
  label: string;
  value: number | string;
  accent?: string;
  hint?: string;
};

/** Responsive, display-only summary cards shared by the report screens. */
export function ReportSummaryCards({ items }: { items: ReportSummaryMetric[] }) {
  return (
    <div
      className="zreport-summary-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 10,
        marginBottom: 14,
      }}
    >
      {items.map((item, index) => (
        <Card key={item.label} style={{ minWidth: 0 }}>
          <div data-testid={`report-metric-${index}`} style={{ padding: "11px 14px", borderTop: `3px solid ${item.accent ?? "#2563eb"}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b" }}>{item.label}</div>
            <div
              data-testid={`report-metric-value-${index}`}
              dir="ltr"
              style={{
                marginTop: 5,
                color: "#172033",
                fontSize: 20,
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums",
                overflowWrap: "anywhere",
              }}
            >
              {typeof item.value === "number" ? fmt(item.value) : item.value}
            </div>
            {item.hint && <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 11 }}>{item.hint}</div>}
          </div>
        </Card>
      ))}
    </div>
  );
}
