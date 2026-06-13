// التحكم في الترحيل — posting policy control (standalone, admin-only).
//
// Controls whether documents post to the general ledger automatically the
// moment they are saved, or are saved as DRAFT and posted later by hand from
// مركز الترحيل. A master flag sets the default for everything; per-document
// overrides can force a specific type to auto / manual regardless of the
// master flag (or keep following it).
//
// SEMANTICS (per the PostingSettings contract):
//   master autoPostingEnabled = false (default) → docs save as DRAFT.
//   per-type value: null = follow master flag, true = force auto-post,
//   false = force manual (draft).

import { useEffect, useMemo, useState } from "react";
import {
  getPostingSettings, setPostingSettings, type PostingSettings,
} from "../lib/accounting";
import {
  Page, Card, ErrorMsg, Empty, btnPrimary,
} from "./_adminUi";

type DocKey = "sale" | "purchase" | "saleReturn" | "purchaseReturn" | "voucher" | "treasuryTransfer";

const DOC_ROWS: { key: DocKey; label: string }[] = [
  { key: "sale", label: "فواتير المبيعات" },
  { key: "purchase", label: "فواتير المشتريات" },
  { key: "saleReturn", label: "مرتجع المبيعات" },
  { key: "purchaseReturn", label: "مرتجع المشتريات" },
  { key: "voucher", label: "السندات" },
  { key: "treasuryTransfer", label: "تحويلات الخزينة" },
];

const TRI_OPTIONS: { value: "default" | "auto" | "manual"; label: string }[] = [
  { value: "default", label: "حسب الإعداد العام" },
  { value: "auto", label: "ترحيل تلقائي" },
  { value: "manual", label: "يدوي (مسودة)" },
];

function toTri(v: boolean | null): "default" | "auto" | "manual" {
  if (v === null) return "default";
  return v ? "auto" : "manual";
}
function fromTri(v: "default" | "auto" | "manual"): boolean | null {
  if (v === "default") return null;
  return v === "auto";
}

function Segmented({ value, onChange, disabled }: {
  value: "default" | "auto" | "manual";
  onChange: (v: "default" | "auto" | "manual") => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", padding: 3, gap: 3 }}>
      {TRI_OPTIONS.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: on ? 700 : 500,
              cursor: disabled ? "not-allowed" : "pointer",
              background: on ? "#2563eb" : "transparent",
              color: on ? "#fff" : "#475569",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function PostingControl() {
  const [state, setState] = useState<PostingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await getPostingSettings();
      setState(s);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function patch(p: Partial<PostingSettings>) {
    setState((prev) => (prev ? { ...prev, ...p } : prev));
    setSaved(false);
    setSaveError(null);
  }

  async function save() {
    if (!state) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await setPostingSettings(state);
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const subtitle = useMemo(
    () => "تحكّم في طريقة ترحيل المستندات إلى الأستاذ العام: تلقائياً فور الحفظ أو يدوياً كمسودة تُرحَّل لاحقاً من مركز الترحيل.",
    [],
  );

  const auto = state?.autoPostingEnabled ?? false;

  return (
    <Page title="التحكم في الترحيل" subtitle={subtitle}>
      {loadError && <ErrorMsg text={loadError} />}
      {loading || !state ? (
        <Card><Empty text="جارٍ التحميل..." /></Card>
      ) : (
        <>
          <Card style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>الترحيل التلقائي للمستندات</div>
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 6, lineHeight: 1.8 }}>
                  عند الإيقاف: تُحفظ المستندات كمسودة وتُرحَّل يدوياً من مركز الترحيل.<br />
                  عند التفعيل: تُرحَّل المستندات إلى الأستاذ العام فور الحفظ.
                </div>
              </div>
              <button
                type="button"
                onClick={() => patch({ autoPostingEnabled: !auto })}
                role="switch"
                aria-checked={auto}
                style={{
                  position: "relative",
                  width: 56,
                  height: 30,
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  background: auto ? "#16a34a" : "#cbd5e1",
                  transition: "background .15s",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 3,
                    insetInlineStart: auto ? 29 : 3,
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: "#fff",
                    boxShadow: "0 1px 3px rgba(0,0,0,.2)",
                    transition: "inset-inline-start .15s",
                  }}
                />
              </button>
            </div>
            <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: auto ? "#16a34a" : "#b45309" }}>
              {auto ? "الوضع الحالي: ترحيل تلقائي فور الحفظ" : "الوضع الحالي: حفظ كمسودة وترحيل يدوي"}
            </div>
          </Card>

          <Card style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>تخصيص حسب نوع المستند</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16, lineHeight: 1.8 }}>
              يمكنك تجاوز الإعداد العام لكل نوع مستند: «حسب الإعداد العام» يتبع المفتاح أعلاه،
              «ترحيل تلقائي» يفرض الترحيل الفوري، و«يدوي (مسودة)» يفرض الحفظ كمسودة.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {DOC_ROWS.map((row) => (
                <div
                  key={row.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "10px 0",
                    borderTop: "1px solid #f1f5f9",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{row.label}</div>
                  <Segmented
                    value={toTri(state[row.key])}
                    onChange={(v) => patch({ [row.key]: fromTri(v) } as Partial<PostingSettings>)}
                  />
                </div>
              ))}
            </div>
          </Card>

          {saveError && <ErrorMsg text={saveError} />}

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "جارٍ الحفظ..." : "حفظ"}
            </button>
            {saved && <span style={{ color: "#16a34a", fontSize: 14, fontWeight: 600 }}>✓ تم حفظ الإعدادات</span>}
          </div>
        </>
      )}
    </Page>
  );
}
