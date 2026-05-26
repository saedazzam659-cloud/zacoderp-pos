// Standalone username/password login — Task #199.
//
// Shown when:
//   • app mode = "standalone"
//   • a license is loaded
//   • there are ≥ 1 local users
//   • no active session
//
// No cloud calls. Auth is PBKDF2-SHA256 (100k iters) against locally stored
// per-user salt+hash in localStorage.

import { useState } from "react";
import { authLocalUser, type LocalSession, listLocalUsers } from "../lib/standalone";

export default function StandaloneLogin({ onSignedIn, customerName }: {
  onSignedIn: (s: LocalSession) => void;
  customerName: string;
}) {
  const usernames = listLocalUsers().map((u) => u.username);
  const [username, setUsername] = useState(usernames[0] ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const s = await authLocalUser(username, password);
      onSignedIn(s);
    } catch (e: any) { setErr(e?.message ?? "فشل تسجيل الدخول"); }
    finally { setBusy(false); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <form onSubmit={submit} style={S.card}>
        <div style={S.brand}>
          <div style={S.brandIcon}>zacode</div>
          <div>
            <div style={S.brandName}>{customerName}</div>
            <div style={S.brandTag}>تسجيل دخول الكاشير — وضع مستقل</div>
          </div>
        </div>
        <label style={S.label}>
          اسم المستخدم
          <input value={username} onChange={(e) => setUsername(e.target.value)}
                 list="standalone-users" autoFocus style={S.input} />
          <datalist id="standalone-users">
            {usernames.map((u) => <option key={u} value={u} />)}
          </datalist>
        </label>
        <label style={S.label}>
          كلمة المرور
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={S.input} />
        </label>
        {err && <div style={S.err}>⚠️ {err}</div>}
        <button disabled={busy || !username || !password} style={S.btn}>
          {busy ? "جارٍ التحقق…" : "دخول"}
        </button>
        <div style={S.foot}>
          نسي كلمة المرور؟ تواصل مع مسؤول الجهاز لإعادة التعيين من شاشة المستخدمين.
        </div>
      </form>
    </div>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)", padding: 24, fontFamily: "'Segoe UI', system-ui, sans-serif" } as const,
  card: { maxWidth: 420, width: "100%", background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,.3)", display: "flex", flexDirection: "column" as const, gap: 14 } as const,
  brand: { display: "flex", gap: 12, alignItems: "center", paddingBottom: 12, borderBottom: "1px solid #e2e8f0" } as const,
  brandIcon: { minWidth: 60, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #22d3ee, #2563eb)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 12 } as const,
  brandName: { fontSize: 16, fontWeight: 700, color: "#0f172a" } as const,
  brandTag: { fontSize: 12, color: "#64748b", marginTop: 2 } as const,
  label: { display: "flex", flexDirection: "column" as const, gap: 6, fontSize: 13, fontWeight: 600, color: "#334155" } as const,
  input: { padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, fontFamily: "inherit" } as const,
  err: { padding: 10, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13 } as const,
  btn: { padding: "12px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 15, fontWeight: 700 } as const,
  foot: { fontSize: 11, color: "#94a3b8", textAlign: "center" as const, marginTop: 4 } as const,
};
