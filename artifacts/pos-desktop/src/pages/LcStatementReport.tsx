import { Page, Card } from "./_adminUi";

// Placeholder — the Letters-of-Credit (LC) module lands in a later wave (W4).
// Once the Rust lc / lc_expenses tables + commands exist, this becomes the LC
// account statement (charges, expenses, settlements per LC). Kept registered now
// so the nav slot + module gate are wired and the fill-in is a single-file edit.
export default function LcStatementReport() {
  return (
    <Page title="كشف حساب الاعتمادات المستندية" subtitle="تقرير حركة الاعتمادات المستندية (LC) ومصروفاتها.">
      <Card>
        <div style={{ padding: "32px 16px", textAlign: "center", color: "#64748b", fontSize: 14, lineHeight: 1.9 }}>
          وحدة الاعتمادات المستندية قيد التطوير وستتوفر قريباً.
          <br />
          سيعرض هذا التقرير حركة كل اعتماد مستندي ومصروفاته وتسوياته بعد تفعيل الوحدة.
        </div>
      </Card>
    </Page>
  );
}
