// Task #201 — scale (weighing) settings page.
//
// Lets the operator wire a serial scale + tune the embedded-weight
// barcode profile. Everything lives in localStorage (pos_desktop_scale_cfg_v1)
// since there is no per-company server config for desktop peripherals.

import { useEffect, useState } from "react";
import {
  getScaleConfig, setScaleConfig, listScalePorts, readWeightOnce,
  DEFAULT_SCALE_CONFIG, type ScaleConfig, type ScaleProtocol,
  type ScaleParity, type ScaleDataBits,
} from "../lib/scale";
import { SearchCombobox } from "./_adminUi";
import { uiText, useUiLanguage } from "../lib/appSettings";

export default function ScaleSettings() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [cfg, setCfg] = useState<ScaleConfig>(() => getScaleConfig());
  const [ports, setPorts] = useState<string[]>([]);
  const [testWeight, setTestWeight] = useState<number | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { void listScalePorts().then(setPorts).catch(() => setPorts([])); }, []);

  function patch<K extends keyof ScaleConfig>(k: K, v: ScaleConfig[K]) {
    setCfg((p) => ({ ...p, [k]: v }));
    setSaved(false);
  }
  function patchEmbedded<K extends keyof ScaleConfig["embedded"]>(
    k: K, v: ScaleConfig["embedded"][K],
  ) {
    setCfg((p) => ({ ...p, embedded: { ...p.embedded, [k]: v } }));
    setSaved(false);
  }

  function save() {
    setScaleConfig(cfg);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  }

  function resetDefaults() {
    setCfg(DEFAULT_SCALE_CONFIG);
    setSaved(false);
  }

  async function testRead() {
    setTesting(true); setTestErr(null); setTestWeight(null);
    try {
      // Save first so the Rust side reads the right port/baud/protocol.
      setScaleConfig(cfg);
      const kg = await readWeightOnce();
      setTestWeight(kg);
    } catch (e: any) {
      setTestErr(e?.message ?? text("فشل قراءة الميزان", "Could not read the scale."));
    } finally { setTesting(false); }
  }

  return (
    <div dir={language === "en" ? "ltr" : "rtl"} style={S.wrap}>
      <h2 style={S.h2}>⚖️ {text("إعدادات الميزان", "Scale settings")}</h2>
      <p style={S.sub}>
        {text(
          "وحدة الميزان تدعم نوعين منفصلين: (1) ميزان مربوط بالكاشير عبر منفذ تسلسلي (RS-232/USB)، (2) باركود الميزان المطبوع على المنتج (يحتوي على PLU + الوزن).",
          "The scale module supports two separate methods: (1) a scale connected to the till through a serial port (RS-232/USB), and (2) a product barcode printed by the scale that contains the PLU and weight.",
        )}
      </p>

      <section style={S.card}>
        <h3 style={S.h3}>{text("القراءة الحيّة من الميزان (Serial)", "Live scale reading (serial)")}</h3>
        <div style={S.row2}>
          <Field label={text("منفذ الاتصال", "Connection port")}>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <SearchCombobox
                  value={cfg.port}
                  onChange={(v) => patch("port", String(v))}
                  style={S.input}
                  placeholder={text("— معطّل —", "— Disabled —")}
                  options={[
                    { value: "", label: text("— معطّل —", "— Disabled —") },
                    ...ports.map((p) => ({ value: p, label: p })),
                    ...(cfg.port && !ports.includes(cfg.port)
                      ? [{ value: cfg.port, label: `${cfg.port} (${text("مخصّص", "custom")})` }]
                      : []),
                  ]}
                />
              </div>
              <button type="button" onClick={() => void listScalePorts().then(setPorts)} style={S.btnGhost}>
                🔄
              </button>
            </div>
          </Field>
          <Field label={text("سرعة الاتصال (baud)", "Connection speed (baud)")}>
            <SearchCombobox
              value={cfg.baud}
              onChange={(v) => patch("baud", Number(v))}
              style={S.input}
              options={[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => ({
                value: b, label: String(b),
              }))}
            />
          </Field>
        </div>
        <div style={S.row2}>
          <Field label={text("Parity (التماثل)", "Parity")}>
            <SearchCombobox
              value={cfg.parity}
              onChange={(v) => patch("parity", v as ScaleParity)}
              style={S.input}
              options={[
                { value: "none", label: text("None (لا يوجد)", "None") },
                { value: "odd", label: text("Odd (فردي)", "Odd") },
                { value: "even", label: text("Even (زوجي)", "Even") },
              ]}
            />
          </Field>
          <Field label={text("Data bits (خانات البيانات)", "Data bits")}>
            <SearchCombobox
              value={cfg.dataBits}
              onChange={(v) => patch("dataBits", Number(v) as ScaleDataBits)}
              style={S.input}
              options={[5, 6, 7, 8].map((n) => ({ value: n, label: String(n) }))}
            />
          </Field>
        </div>
        <Field label={text("البروتوكول", "Protocol")}>
          <SearchCombobox
            value={cfg.protocol}
            onChange={(v) => patch("protocol", v as ScaleProtocol)}
            style={S.input}
            options={[
              { value: "generic_ascii", label: text('عام (ASCII) — صيغة "  1.234 kg"', 'Generic (ASCII) — format "  1.234 kg"') },
              { value: "cas", label: "CAS" },
              { value: "bizerba", label: "Bizerba" },
            ]}
          />
        </Field>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button onClick={testRead} disabled={testing || !cfg.port} style={S.btnPrimary}>
            {testing ? "..." : text("اختبار الاتصال + قراءة وزن", "Test connection and read weight")}
          </button>
          {testWeight !== null && (
            <span style={S.weightChip}>✅ {testWeight.toFixed(3)} {text("كجم", "kg")}</span>
          )}
          {testErr && <span style={S.errInline}>⚠️ {testErr}</span>}
        </div>
      </section>

      <section style={S.card}>
        <h3 style={S.h3}>{text("باركود الميزان (PLU + الوزن مدمج)", "Scale barcode (PLU + embedded weight)")}</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 14, color: "#0f172a", fontWeight: 600 }}>
          <input type="checkbox" checked={cfg.embedded.enabled}
            onChange={(e) => patchEmbedded("enabled", e.target.checked)} />
          {text("تفعيل قراءة الوزن من الباركود", "Enable weight reading from barcodes")}
        </label>
        <p style={S.sub}>
          {text("يقوم ميزان الديلي/الخضار بطباعة باركود EAN-13 يبدأ بـ", "The deli/produce scale prints an EAN-13 barcode beginning with")} <strong>{cfg.embedded.prefix || "20/22"}</strong>
          {text("، ثم رقم PLU، ثم رقم الوزن. عند مسحه ستفتح السلة الصنف المطابق وتضع الوزن كميةً.", ", followed by the PLU and weight. Scanning it adds the matching item to the cart with that weight as the quantity.")}
        </p>
        <div style={S.row2}>
          <Field label={text("بادئة (Prefix)", "Prefix")}>
            <input value={cfg.embedded.prefix} maxLength={2}
              onChange={(e) => patchEmbedded("prefix", e.target.value.replace(/\D/g, ""))}
              style={S.input} placeholder="20" />
          </Field>
          <Field label={text("عدد خانات PLU", "PLU digit count")}>
            <input type="number" min={3} max={6} value={cfg.embedded.pluLen}
              onChange={(e) => patchEmbedded("pluLen", Math.max(3, Math.min(6, Number(e.target.value))))}
              style={S.input} />
          </Field>
        </div>
        <div style={S.row2}>
          <Field label={text("عدد خانات الوزن", "Weight digit count")}>
            <input type="number" min={3} max={6} value={cfg.embedded.weightLen}
              onChange={(e) => patchEmbedded("weightLen", Math.max(3, Math.min(6, Number(e.target.value))))}
              style={S.input} />
          </Field>
          <Field label={text("عدد منازل الكسر العشري للوزن", "Weight decimal places")}>
            <input type="number" min={0} max={4} value={cfg.embedded.weightDecimals}
              onChange={(e) => patchEmbedded("weightDecimals", Math.max(0, Math.min(4, Number(e.target.value))))}
              style={S.input} />
          </Field>
        </div>
        <p style={S.muted}>
          {text("مثال للحساب:", "Example:")} ‎20·12345·01234·X‎ → PLU = 12345, {text("الوزن", "weight")} = 1.234 {text("كجم", "kg")}
          {text(" (آخر منزلة = خانة التحقق X، تتجاهلها القارئة).", " (The last digit is the check digit X and is ignored by the scanner.)")}
        </p>
      </section>

      <div style={S.btnRow}>
        <button onClick={save} style={S.btnPrimary}>💾 {text("حفظ الإعدادات", "Save settings")}</button>
        <button onClick={resetDefaults} style={S.btnGhost}>↺ {text("إعادة الافتراضيات", "Reset to defaults")}</button>
        {saved && <span style={S.okInline}>✅ {text("تم الحفظ", "Saved")}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 12 }}>
    <div style={{ fontSize: 13, color: "#475569", marginBottom: 4 }}>{label}</div>
    {children}
  </label>;
}

const S = {
  wrap: { width: "100%", maxWidth: "none", minWidth: 0, boxSizing: "border-box" as const } as const,
  h2: { margin: "0 0 8px", fontSize: 22, color: "#0f172a" } as const,
  h3: { margin: "0 0 12px", fontSize: 16, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginBottom: 16, lineHeight: 1.7 } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 20, marginBottom: 16 } as const,
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnGhost: { padding: "10px 14px", background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 14 } as const,
  btnRow: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 } as const,
  weightChip: { padding: "6px 12px", background: "#dcfce7", color: "#166534", border: "1px solid #86efac", borderRadius: 999, fontSize: 14, fontWeight: 600 } as const,
  okInline: { color: "#166534", fontSize: 13 } as const,
  errInline: { color: "#991b1b", fontSize: 13 } as const,
  muted: { fontSize: 12, color: "#94a3b8", marginTop: 4 } as const,
};
