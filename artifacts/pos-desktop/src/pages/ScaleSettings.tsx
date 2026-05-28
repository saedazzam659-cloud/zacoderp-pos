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

export default function ScaleSettings() {
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
      setTestErr(e?.message ?? "فشل قراءة الميزان");
    } finally { setTesting(false); }
  }

  return (
    <div style={S.wrap}>
      <h2 style={S.h2}>⚖️ إعدادات الميزان</h2>
      <p style={S.sub}>
        وحدة الميزان تدعم نوعين منفصلين: (1) ميزان مربوط بالكاشير عبر منفذ تسلسلي (RS-232/USB)،
        (2) باركود الميزان المطبوع على المنتج (يحتوي على PLU + الوزن).
      </p>

      <section style={S.card}>
        <h3 style={S.h3}>القراءة الحيّة من الميزان (Serial)</h3>
        <div style={S.row2}>
          <Field label="منفذ الاتصال">
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <SearchCombobox
                  value={cfg.port}
                  onChange={(v) => patch("port", String(v))}
                  style={S.input}
                  placeholder="— معطّل —"
                  options={[
                    { value: "", label: "— معطّل —" },
                    ...ports.map((p) => ({ value: p, label: p })),
                    ...(cfg.port && !ports.includes(cfg.port)
                      ? [{ value: cfg.port, label: `${cfg.port} (مخصّص)` }]
                      : []),
                  ]}
                />
              </div>
              <button type="button" onClick={() => void listScalePorts().then(setPorts)} style={S.btnGhost}>
                🔄
              </button>
            </div>
          </Field>
          <Field label="سرعة الاتصال (baud)">
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
          <Field label="Parity (التماثل)">
            <SearchCombobox
              value={cfg.parity}
              onChange={(v) => patch("parity", v as ScaleParity)}
              style={S.input}
              options={[
                { value: "none", label: "None (لا يوجد)" },
                { value: "odd", label: "Odd (فردي)" },
                { value: "even", label: "Even (زوجي)" },
              ]}
            />
          </Field>
          <Field label="Data bits (خانات البيانات)">
            <SearchCombobox
              value={cfg.dataBits}
              onChange={(v) => patch("dataBits", Number(v) as ScaleDataBits)}
              style={S.input}
              options={[5, 6, 7, 8].map((n) => ({ value: n, label: String(n) }))}
            />
          </Field>
        </div>
        <Field label="البروتوكول">
          <SearchCombobox
            value={cfg.protocol}
            onChange={(v) => patch("protocol", v as ScaleProtocol)}
            style={S.input}
            options={[
              { value: "generic_ascii", label: 'عام (ASCII) — صيغة "  1.234 kg"' },
              { value: "cas", label: "CAS" },
              { value: "bizerba", label: "Bizerba" },
            ]}
          />
        </Field>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button onClick={testRead} disabled={testing || !cfg.port} style={S.btnPrimary}>
            {testing ? "..." : "اختبار الاتصال + قراءة وزن"}
          </button>
          {testWeight !== null && (
            <span style={S.weightChip}>✅ {testWeight.toFixed(3)} كجم</span>
          )}
          {testErr && <span style={S.errInline}>⚠️ {testErr}</span>}
        </div>
      </section>

      <section style={S.card}>
        <h3 style={S.h3}>باركود الميزان (PLU + الوزن مدمج)</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 14, color: "#0f172a", fontWeight: 600 }}>
          <input type="checkbox" checked={cfg.embedded.enabled}
            onChange={(e) => patchEmbedded("enabled", e.target.checked)} />
          تفعيل قراءة الوزن من الباركود
        </label>
        <p style={S.sub}>
          يقوم ميزان الديلي/الخضار بطباعة باركود EAN-13 يبدأ بـ <strong>{cfg.embedded.prefix || "20/22"}</strong>،
          ثم رقم PLU، ثم رقم الوزن. عند مسحه ستفتح السلة الصنف المطابق وتضع الوزن كميةً.
        </p>
        <div style={S.row2}>
          <Field label="بادئة (Prefix)">
            <input value={cfg.embedded.prefix} maxLength={2}
              onChange={(e) => patchEmbedded("prefix", e.target.value.replace(/\D/g, ""))}
              style={S.input} placeholder="20" />
          </Field>
          <Field label="عدد خانات PLU">
            <input type="number" min={3} max={6} value={cfg.embedded.pluLen}
              onChange={(e) => patchEmbedded("pluLen", Math.max(3, Math.min(6, Number(e.target.value))))}
              style={S.input} />
          </Field>
        </div>
        <div style={S.row2}>
          <Field label="عدد خانات الوزن">
            <input type="number" min={3} max={6} value={cfg.embedded.weightLen}
              onChange={(e) => patchEmbedded("weightLen", Math.max(3, Math.min(6, Number(e.target.value))))}
              style={S.input} />
          </Field>
          <Field label="عدد منازل الكسر العشري للوزن">
            <input type="number" min={0} max={4} value={cfg.embedded.weightDecimals}
              onChange={(e) => patchEmbedded("weightDecimals", Math.max(0, Math.min(4, Number(e.target.value))))}
              style={S.input} />
          </Field>
        </div>
        <p style={S.muted}>
          مثال للحساب: ‎20·12345·01234·X‎ → PLU = 12345، الوزن = 1.234 كجم
          (آخر منزلة = خانة التحقق X، تتجاهلها القارئة).
        </p>
      </section>

      <div style={S.btnRow}>
        <button onClick={save} style={S.btnPrimary}>💾 حفظ الإعدادات</button>
        <button onClick={resetDefaults} style={S.btnGhost}>↺ إعادة الافتراضيات</button>
        {saved && <span style={S.okInline}>✅ تم الحفظ</span>}
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
  wrap: { maxWidth: 900, margin: "0 auto", width: "100%" } as const,
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
