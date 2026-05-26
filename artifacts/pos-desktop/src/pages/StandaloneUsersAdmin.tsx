// Local users administration (standalone mode) — Task #199.
//
// Lists, adds, removes, and resets password for local users. Only visible
// to users with role="admin". Lives inside PosShell as the "users" view.

import { useEffect, useState } from "react";
import {
  listLocalUsers, createLocalUser, deleteLocalUser, changeLocalPassword,
  type LocalUser, type LocalUserRole, type LocalSession,
} from "../lib/standalone";

export default function StandaloneUsersAdmin({ session, maxUsers }: { session: LocalSession; maxUsers: number }) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<LocalUser | null>(null);
  const isAdmin = session.role === "admin";

  async function refresh() { setUsers(await listLocalUsers()); }
  useEffect(() => { void refresh(); }, []);

  if (!isAdmin) {
    return <div style={{ padding: 24, color: "#dc2626" }}>هذه الشاشة متاحة لمستخدمي الإدارة فقط.</div>;
  }

  async function remove(u: LocalUser) {
    if (u.username === session.username) { alert("لا يمكنك حذف المستخدم الذي سجّلت الدخول به."); return; }
    if (users.filter((x) => x.role === "admin").length <= 1 && u.role === "admin") {
      alert("يجب أن يبقى مسؤول واحد على الأقل."); return;
    }
    if (!confirm(`حذف المستخدم ${u.username}؟`)) return;
    await deleteLocalUser(u.id); await refresh();
  }

  return (
    <div dir="rtl" style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>المستخدمون المحليون</h2>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            {users.length} من أصل {maxUsers} مسموح به في الترخيص
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} disabled={users.length >= maxUsers} style={btnPrimary}>
          + إضافة مستخدم
        </button>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" as const }}>
          <thead style={{ background: "#f8fafc" }}>
            <tr>
              <Th>اسم المستخدم</Th><Th>الاسم</Th><Th>الدور</Th>
              <Th>آخر دخول</Th><Th style={{ width: 180 }}>إجراءات</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <Td mono>{u.username}{u.username === session.username && <span style={{ marginRight: 6, fontSize: 11, color: "#2563eb" }}>(أنت)</span>}</Td>
                <Td>{u.displayName}</Td>
                <Td><RoleBadge role={u.role} /></Td>
                <Td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("ar-SA") : "—"}</Td>
                <Td>
                  <button onClick={() => setResetTarget(u)} style={btnLink}>تغيير كلمة المرور</button>
                  {" · "}
                  <button onClick={() => remove(u)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreateUserModal
          onCancel={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void refresh(); }}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal user={resetTarget} onCancel={() => setResetTarget(null)} onDone={() => { setResetTarget(null); void refresh(); }} />
      )}
    </div>
  );
}

function CreateUserModal({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [u, setU] = useState({ username: "", displayName: "", password: "", role: "cashier" as LocalUserRole });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try { await createLocalUser(u); onCreated(); }
    catch (e: any) { setErr(e?.message ?? "فشل الإنشاء"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="إضافة مستخدم محلي" onCancel={onCancel}>
      <Field label="اسم المستخدم"><input value={u.username} onChange={(e) => setU({ ...u, username: e.target.value })} style={input} /></Field>
      <Field label="الاسم الكامل"><input value={u.displayName} onChange={(e) => setU({ ...u, displayName: e.target.value })} style={input} /></Field>
      <Field label="الدور">
        <select value={u.role} onChange={(e) => setU({ ...u, role: e.target.value as LocalUserRole })} style={input}>
          <option value="cashier">كاشير</option>
          <option value="admin">مسؤول</option>
        </select>
      </Field>
      <Field label="كلمة المرور"><input type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} style={input} /></Field>
      {err && <div style={errStyle}>⚠️ {err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !u.username || !u.password} style={btnPrimary}>حفظ</button>
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ user, onCancel, onDone }: { user: LocalUser; onCancel: () => void; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try { await changeLocalPassword(user.id, pw); onDone(); }
    catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`تغيير كلمة مرور ${user.username}`} onCancel={onCancel}>
      <Field label="كلمة المرور الجديدة"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} style={input} autoFocus /></Field>
      {err && <div style={errStyle}>⚠️ {err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onCancel} style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy || !pw} style={btnPrimary}>حفظ</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <div dir="rtl" onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, width: 420, maxWidth: "92vw" }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>{label}</div>
    {children}
  </label>;
}
function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ textAlign: "right" as const, padding: "10px 14px", fontSize: 12, color: "#64748b", fontWeight: 600, ...style }}>{children}</th>;
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td style={{ padding: "10px 14px", fontSize: 14, fontFamily: mono ? "ui-monospace, monospace" : undefined }}>{children}</td>;
}
function RoleBadge({ role }: { role: LocalUserRole }) {
  const cls = role === "admin" ? { bg: "#dbeafe", fg: "#1e40af", label: "مسؤول" } : { bg: "#f1f5f9", fg: "#475569", label: "كاشير" };
  return <span style={{ background: cls.bg, color: cls.fg, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{cls.label}</span>;
}

const input: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" };
const btnPrimary: React.CSSProperties = { padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { padding: "8px 16px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14 };
const btnLink: React.CSSProperties = { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 };
const errStyle: React.CSSProperties = { padding: 8, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 6, fontSize: 13, marginTop: 8 };
