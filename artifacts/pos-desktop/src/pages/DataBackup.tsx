// النسخ الاحتياطي — backup / restore + auto-backup + data-folder location.
// Standalone, admin-only. Lives in the "التحكم العام" group.
//
// - Export: native "Save As" → copies the live pos.db to a chosen file.
// - Import: native open → copies a chosen .db OVER the live db (restart after).
// - Auto-backup: enable + pick a folder + set a daily time. Runs only while
//   the app is OPEN (a closed app cannot back itself up — stated in the UI).
// - Data folder: shows the current location and lets the user move it.
import { useEffect, useState } from "react";
import {
  getBackupSettings,
  setBackupSettings,
  runBackupNow,
  exportBackup,
  importBackup,
  pickFolder,
  setDataDir,
  type BackupSettings,
} from "../lib/backup";
import { Page, Card, ErrorMsg, btnPrimary, btnSecondary, input } from "./_adminUi";

type Toast = { kind: "ok" | "err"; text: string } | null;

export default function DataBackup() {
  const [s, setS] = useState<BackupSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Local editable copy of the auto-backup settings.
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoTime, setAutoTime] = useState("23:00");
  const [backupDir, setBackupDir] = useState("");

  async function load() {
    setLoading(true);
    try {
      const cfg = await getBackupSettings();
      setS(cfg);
      setAutoEnabled(cfg.autoEnabled);
      setAutoTime(cfg.autoTime || "23:00");
      setBackupDir(cfg.backupDir || "");
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر تحميل الإعدادات");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  function flash(t: Toast) {
    setToast(t);
    if (t) setTimeout(() => setToast(null), 4000);
  }

  async function onExport() {
    setBusy(true); setErr(null);
    try {
      const path = await exportBackup();
      if (path) flash({ kind: "ok", text: `تم حفظ النسخة الاحتياطية في: ${path}` });
    } catch (e: any) { setErr(e?.message ?? "فشل التصدير"); }
    finally { setBusy(false); }
  }

  async function onImport() {
    if (!confirm(
      "سيتم استبدال قاعدة البيانات الحالية بالكامل بمحتوى الملف المختار.\n" +
      "تأكد من أخذ نسخة احتياطية أولاً. يُنصح بإعادة تشغيل البرنامج بعد الاستيراد.\n\nهل تريد المتابعة؟"
    )) return;
    setBusy(true); setErr(null);
    try {
      const path = await importBackup();
      if (path) flash({ kind: "ok", text: "تم استيراد قاعدة البيانات. الرجاء إعادة تشغيل البرنامج الآن." });
    } catch (e: any) { setErr(e?.message ?? "فشل الاستيراد"); }
    finally { setBusy(false); }
  }

  async function onPickBackupDir() {
    setErr(null);
    try {
      const dir = await pickFolder();
      if (dir) setBackupDir(dir);
    } catch (e: any) { setErr(e?.message ?? "تعذّر اختيار المجلد"); }
  }

  async function onSaveAuto() {
    if (autoEnabled && !backupDir.trim()) {
      setErr("اختر مجلد النسخ الاحتياطي أولاً");
      return;
    }
    setBusy(true); setErr(null);
    try {
      await setBackupSettings({ autoEnabled, autoTime, backupDir: backupDir.trim() });
      await load();
      flash({ kind: "ok", text: "تم حفظ إعدادات النسخ التلقائي" });
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  async function onRunNow() {
    setBusy(true); setErr(null);
    try {
      const path = await runBackupNow();
      await load();
      flash({ kind: "ok", text: `تم إنشاء نسخة احتياطية: ${path}` });
    } catch (e: any) { setErr(e?.message ?? "فشل النسخ"); }
    finally { setBusy(false); }
  }

  async function onMoveData() {
    setErr(null);
    let dir: string | null;
    try {
      dir = await pickFolder();
    } catch (e: any) { setErr(e?.message ?? "تعذّر اختيار المجلد"); return; }
    if (!dir) return;
    if (!confirm(
      `سيتم نقل قاعدة البيانات إلى:\n${dir}\n\n` +
      "سيتم إنشاء ملف pos.db في هذا المجلد. يُنصح بإعادة تشغيل البرنامج بعد النقل.\nهل تريد المتابعة؟"
    )) return;
    setBusy(true);
    try {
      const newPath = await setDataDir(dir);
      await load();
      flash({ kind: "ok", text: `تم نقل قاعدة البيانات إلى: ${newPath}. الرجاء إعادة التشغيل.` });
    } catch (e: any) { setErr(e?.message ?? "فشل نقل قاعدة البيانات"); }
    finally { setBusy(false); }
  }

  async function onResetData() {
    if (!confirm("إرجاع موقع قاعدة البيانات إلى المجلد الافتراضي؟ يُنصح بإعادة التشغيل بعد ذلك.")) return;
    setBusy(true); setErr(null);
    try {
      const newPath = await setDataDir(null);
      await load();
      flash({ kind: "ok", text: `تم الإرجاع إلى المجلد الافتراضي: ${newPath}. الرجاء إعادة التشغيل.` });
    } catch (e: any) { setErr(e?.message ?? "فشل الإرجاع"); }
    finally { setBusy(false); }
  }

  if (loading) return <Page title="النسخ الاحتياطي"><Card><div style={{ padding: 16 }}>... جاري التحميل</div></Card></Page>;

  const lastBackup = s?.lastBackupAt
    ? new Date(s.lastBackupAt).toLocaleString("ar-SA")
    : "لم يتم بعد";

  return (
    <Page title="النسخ الاحتياطي" subtitle="حماية بياناتك: تصدير / استيراد، نسخ تلقائي، وموقع قاعدة البيانات">
      <ErrorMsg text={err} />
      {toast && (
        <div style={toast.kind === "ok" ? okBox : errBox}>{toast.text}</div>
      )}

      {/* Manual export / import */}
      <Card style={card}>
        <div style={sectionTitle}>نسخ احتياطي يدوي</div>
        <p style={muted}>
          «تصدير» يحفظ نسخة كاملة من قاعدة البيانات في ملف تختاره. «استيراد» يستبدل
          البيانات الحالية بملف نسخة احتياطية سابق.
        </p>
        <div style={btnRow}>
          <button style={btnPrimary} disabled={busy} onClick={onExport}>⬇️ تصدير نسخة احتياطية…</button>
          <button style={btnSecondary} disabled={busy} onClick={onImport}>⬆️ استيراد / استعادة…</button>
        </div>
      </Card>

      {/* Auto-backup */}
      <Card style={card}>
        <div style={sectionTitle}>النسخ التلقائي اليومي</div>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={autoEnabled}
            onChange={(e) => setAutoEnabled(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <span>تفعيل النسخ الاحتياطي التلقائي</span>
        </label>

        <div style={grid}>
          <div>
            <div style={fieldLabel}>وقت النسخ اليومي</div>
            <input
              type="time"
              value={autoTime}
              onChange={(e) => setAutoTime(e.target.value)}
              style={input}
              disabled={!autoEnabled}
            />
          </div>
          <div>
            <div style={fieldLabel}>مجلد حفظ النسخ</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={backupDir} readOnly placeholder="لم يتم الاختيار" style={{ ...input, flex: 1 }} />
              <button style={btnSecondary} disabled={!autoEnabled} onClick={onPickBackupDir}>اختيار…</button>
            </div>
          </div>
        </div>

        <div style={warn}>
          ⚠️ يعمل النسخ التلقائي فقط أثناء تشغيل البرنامج. إذا كان البرنامج مغلقاً وقت
          النسخ المحدد، سيأخذ النسخة عند أول تشغيل بعد ذلك الوقت في نفس اليوم.
        </div>

        <div style={btnRow}>
          <button style={btnPrimary} disabled={busy} onClick={onSaveAuto}>حفظ الإعدادات</button>
          <button style={btnSecondary} disabled={busy || !backupDir.trim()} onClick={onRunNow}>📦 نسخ الآن</button>
        </div>
        <div style={muted}>آخر نسخة احتياطية: {lastBackup}</div>
      </Card>

      {/* Data folder location */}
      <Card style={card}>
        <div style={sectionTitle}>موقع قاعدة البيانات</div>
        <div style={fieldLabel}>الموقع الحالي</div>
        <div style={pathBox}>{s?.dataDir}</div>
        {s?.isCustomDataDir && (
          <div style={muted}>المجلد الافتراضي: {s?.defaultDataDir}</div>
        )}
        <p style={muted}>
          يمكنك نقل قاعدة البيانات إلى مجلد آخر (مثل قرص خارجي أو مجلد مشترك). سيتم نقل
          الملف وتذكُّر الموقع الجديد عند كل تشغيل. يُنصح بإعادة تشغيل البرنامج بعد النقل.
        </p>
        <div style={btnRow}>
          <button style={btnPrimary} disabled={busy} onClick={onMoveData}>📁 نقل قاعدة البيانات…</button>
          {s?.isCustomDataDir && (
            <button style={btnSecondary} disabled={busy} onClick={onResetData}>إرجاع إلى الافتراضي</button>
          )}
        </div>
      </Card>
    </Page>
  );
}

const card: React.CSSProperties = { marginBottom: 16, padding: 16 };
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#0f172a" };
const muted: React.CSSProperties = { color: "#64748b", fontSize: 13, margin: "8px 0" };
const fieldLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 4 };
const btnRow: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 };
const checkRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" };
const warn: React.CSSProperties = { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: 10, fontSize: 13, marginTop: 12 };
const pathBox: React.CSSProperties = { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px", fontFamily: "ui-monospace, monospace", fontSize: 13, wordBreak: "break-all" };
const okBox: React.CSSProperties = { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 8, padding: 10, fontSize: 14, marginBottom: 12 };
const errBox: React.CSSProperties = { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: 10, fontSize: 14, marginBottom: 12 };
