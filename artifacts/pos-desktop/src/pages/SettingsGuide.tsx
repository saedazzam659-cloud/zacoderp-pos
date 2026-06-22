// دليل الإعدادات — company profile + number-format settings.
//
// Mirrors the web app's GeneralSettings: upload a company logo, set the
// company identity (name / VAT / CR) used on the professional journal-entry
// print letterhead, and control the decimal places applied across every
// money formatter. All values persist via lib/appSettings (localStorage +
// SQLite mirror in Tauri builds).

import { useEffect, useRef, useState } from "react";
import { Page, Card, Field, ErrorMsg, input, btnPrimary, btnSecondary, btnDanger } from "./_adminUi";
import {
  getCompanyProfile, setCompanyProfile, safeLogoSrc,
  DECIMALS_MIN, DECIMALS_MAX, DECIMALS_DEFAULT, LOGO_MAX_BASE64_CHARS,
} from "../lib/appSettings";

export default function SettingsGuide() {
  const [logo, setLogo] = useState("");
  const [name, setName] = useState("");
  const [vat, setVat] = useState("");
  const [cr, setCr] = useState("");
  const [phone, setPhone] = useState("");
  const [decimals, setDecimals] = useState<number>(DECIMALS_DEFAULT);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const p = getCompanyProfile();
    setLogo(p.logo);
    setName(p.name);
    setVat(p.vat);
    setCr(p.cr);
    setPhone(p.phone);
    setDecimals(p.decimals);
  }, []);

  function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    setErr(null);
    setSaved(false);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setErr("الملف المختار ليس صورة. اختر ملف PNG أو JPG أو SVG.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const safe = safeLogoSrc(dataUrl);
      if (!safe) {
        setErr("تعذّرت قراءة الصورة. جرّب صيغة PNG أو JPG.");
        return;
      }
      if (safe.length > LOGO_MAX_BASE64_CHARS) {
        setErr("حجم الشعار كبير جداً (الحد الأقصى ~1 ميجابايت). اختر صورة أصغر أو اضغطها.");
        return;
      }
      setLogo(safe);
    };
    reader.onerror = () => setErr("تعذّرت قراءة ملف الصورة.");
    reader.readAsDataURL(file);
  }

  function removeLogo() {
    setLogo("");
    setSaved(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function save() {
    setErr(null);
    const dp = Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(Number(decimals) || 0)));
    setCompanyProfile({ logo, name, vat, cr, phone, decimals: dp });
    setDecimals(dp);
    setSaved(true);
  }

  return (
    <Page
      title="دليل الإعدادات"
      subtitle="شعار الشركة وبياناتها وعدد الأرقام العشرية — تظهر في طباعة القيود والمستندات."
    >
      {/* ── Company logo ── */}
      <Card style={{ marginBottom: 16 }}>
        <h3 style={h3}>شعار الشركة</h3>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={logoBox}>
            {logo
              ? <img src={logo} alt="شعار الشركة" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
              : <span style={{ color: "#94a3b8", fontSize: 13 }}>لا يوجد شعار</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
              onChange={onPickLogo}
              style={{ fontSize: 13 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={btnSecondary} onClick={() => fileRef.current?.click()}>
                اختيار صورة
              </button>
              {logo && (
                <button type="button" style={btnDanger} onClick={removeLogo}>إزالة الشعار</button>
              )}
            </div>
            <span style={{ fontSize: 12, color: "#64748b" }}>
              PNG / JPG / SVG — الحد الأقصى ~1 ميجابايت. يظهر في ترويسة طباعة القيد.
            </span>
          </div>
        </div>
      </Card>

      {/* ── Company identity ── */}
      <Card style={{ marginBottom: 16 }}>
        <h3 style={h3}>بيانات الشركة</h3>
        <div style={grid2}>
          <Field label="اسم الشركة">
            <input style={input} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} placeholder="يظهر في ترويسة الطباعة" />
          </Field>
          <Field label="الرقم الضريبي (VAT)">
            <input style={input} value={vat} onChange={(e) => { setVat(e.target.value); setSaved(false); }} inputMode="numeric" placeholder="3xxxxxxxxxxxxx3" />
          </Field>
          <Field label="السجل التجاري (CR)">
            <input style={input} value={cr} onChange={(e) => { setCr(e.target.value); setSaved(false); }} inputMode="numeric" placeholder="10xxxxxxxx" />
          </Field>
          <Field label="رقم الهاتف">
            <input style={input} value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} inputMode="tel" placeholder="مثال: 0555555555" dir="ltr" />
          </Field>
        </div>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          تظهر هذه البيانات في ترويسة طباعة الفواتير والسندات أسفل اسم الشركة.
        </span>
      </Card>

      {/* ── Number format ── */}
      <Card style={{ marginBottom: 16 }}>
        <h3 style={h3}>تنسيق الأرقام</h3>
        <div style={grid2}>
          <Field label={`عدد الأرقام العشرية (${DECIMALS_MIN}–${DECIMALS_MAX})`}>
            <input
              style={{ ...input, maxWidth: 160 }}
              type="number"
              min={DECIMALS_MIN}
              max={DECIMALS_MAX}
              step={1}
              value={decimals}
              onChange={(e) => { setDecimals(Number(e.target.value)); setSaved(false); }}
            />
          </Field>
          <Field label="معاينة">
            <div style={{ ...input, background: "#f8fafc", direction: "ltr", textAlign: "right" }}>
              {Number(1234.56789).toLocaleString("ar-SA", {
                minimumFractionDigits: clampDp(decimals),
                maximumFractionDigits: clampDp(decimals),
              })}
            </div>
          </Field>
        </div>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          يُطبّق على عرض وطباعة كل المبالغ في البرنامج (القيود، الفواتير، التقارير).
        </span>
      </Card>

      <ErrorMsg text={err} />
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button type="button" style={btnPrimary} onClick={save}>حفظ الإعدادات</button>
        {saved && <span style={{ color: "#16a34a", fontSize: 14, fontWeight: 600 }}>✅ تم الحفظ</span>}
      </div>
    </Page>
  );
}

function clampDp(n: number): number {
  return Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(Number(n) || 0)));
}

const h3: React.CSSProperties = { margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "#0f172a" };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 8 };
const logoBox: React.CSSProperties = {
  width: 140, height: 110, border: "1px dashed #cbd5e1", borderRadius: 8,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "#f8fafc", padding: 8, boxSizing: "border-box",
};
