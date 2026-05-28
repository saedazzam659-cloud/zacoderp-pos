// Local users administration (standalone mode) — inline editing variant.

import { useEffect, useState } from "react";
import {
  listLocalUsers, createLocalUser, deleteLocalUser, changeLocalPassword,
  type LocalUser, type LocalUserRole, type LocalSession,
} from "../lib/standalone";
import { SearchCombobox } from "./_adminUi";

type EditState =
  | { mode: "new"; data: { username: string; displayName: string; password: string; role: LocalUserRole } }
  | { mode: "reset"; userId: LocalUser["id"]; password: string }
  | null;

export default function StandaloneUsersAdmin({ session, maxUsers }: { session: LocalSession; maxUsers: number }) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = session.role === "admin";

  async function refresh() { setUsers(await listLocalUsers()); }
  useEffect(() => { void refresh(); }, []);

  if (!isAdmin) {
    return <div style={{ padding: 24, color: "#dc2626" }}>هذه الشاشة متاحة لمستخدمي الإدارة فقط.</div>;
  }

  function startNew() {
    setErr(null);
    setEdit({ mode: "new", data: { username: "", displayName: "", password: "", role: "cashier" } });
  }
  function startReset(u: LocalUser) {
    setErr(null);
    setEdit({ mode: "reset", userId: u.id, password: "" });
  }
  function cancel() { setEdit(null); setErr(null); }

  async function save() {
    if (!edit) return;
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") {
        const d = edit.data;
        if (!d.username || !d.password) { setErr("اسم المستخدم وكلمة المرور مطلوبان"); setBusy(false); return; }
        await createLocalUser(d);
      } else {
        if (!edit.password) { setErr("كلمة المرور مطلوبة"); setBusy(false); return; }
        await changeLocalPassword(edit.userId, edit.password);
      }
      setEdit(null);
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
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
        <button onClick={startNew}
          disabled={users.length >= maxUsers || !!edit}
          style={{ ...btnPrimary, opacity: (users.length >= maxUsers || edit) ? 0.5 : 1, cursor: (users.length >= maxUsers || edit) ? "not-allowed" : "pointer" }}>
          + إضافة مستخدم
        </button>
      </div>

      <div style={{ background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" as const }}>
          <thead style={{ background: "#f8fafc" }}>
            <tr>
              <Th>اسم المستخدم</Th><Th>الاسم</Th><Th>الدور</Th>
              <Th>آخر دخول</Th><Th style={{ width: 220 }}>إجراءات</Th>
            </tr>
          </thead>
          <tbody>
            {edit?.mode === "new" && (
              <NewUserRow data={edit.data} setData={(d) => setEdit({ ...edit, data: d })} onSave={save} onCancel={cancel} busy={busy} err={err} />
            )}
            {users.map((u) => (
              edit?.mode === "reset" && edit.userId === u.id ? (
                <ResetRow key={u.id} user={u} password={edit.password} setPassword={(p) => setEdit({ ...edit, password: p })}
                  onSave={save} onCancel={cancel} busy={busy} err={err} isSelf={u.username === session.username} />
              ) : (
                <tr key={u.id} style={{ borderTop: "1px solid #f1f5f9", opacity: edit ? 0.6 : 1 }}>
                  <Td mono>{u.username}{u.username === session.username && <span style={{ marginRight: 6, fontSize: 11, color: "#2563eb" }}>(أنت)</span>}</Td>
                  <Td>{u.displayName}</Td>
                  <Td><RoleBadge role={u.role} /></Td>
                  <Td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("ar-SA") : "—"}</Td>
                  <Td>
                    <button onClick={() => startReset(u)} disabled={!!edit} style={btnLink}>تغيير كلمة المرور</button>
                    {" · "}
                    <button onClick={() => remove(u)} disabled={!!edit} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                  </Td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewUserRow({ data, setData, onSave, onCancel, busy, err }: {
  data: { username: string; displayName: string; password: string; role: LocalUserRole };
  setData: (d: { username: string; displayName: string; password: string; role: LocalUserRole }) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ borderTop: "1px solid #f1f5f9", background: "#f0fdf4" }}>
        <Td>
          <input autoFocus value={data.username} onChange={(e) => setData({ ...data, username: e.target.value })} style={ci} placeholder="اسم المستخدم *" />
          <input type="password" value={data.password} onChange={(e) => setData({ ...data, password: e.target.value })} style={{ ...ci, marginTop: 4 }} placeholder="كلمة المرور *" />
        </Td>
        <Td><input value={data.displayName} onChange={(e) => setData({ ...data, displayName: e.target.value })} style={ci} placeholder="الاسم الكامل" /></Td>
        <Td>
          <SearchCombobox
            value={data.role}
            onChange={(v) => setData({ ...data, role: v as LocalUserRole })}
            options={[{ value: "cashier", label: "كاشير" }, { value: "admin", label: "مسؤول" }]}
            style={ci}
          />
        </Td>
        <Td>—</Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={btnSavSm}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={btnSecondary}>إلغاء</button>
        </Td>
      </tr>
      {err && <tr><td colSpan={5} style={{ padding: 10, background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</td></tr>}
    </>
  );
}

function ResetRow({ user, password, setPassword, onSave, onCancel, busy, err, isSelf }: {
  user: LocalUser; password: string; setPassword: (p: string) => void;
  onSave: () => void; onCancel: () => void; busy: boolean; err: string | null; isSelf: boolean;
}) {
  const ci: React.CSSProperties = { ...input, padding: "6px 8px", fontSize: 13 };
  return (
    <>
      <tr style={{ borderTop: "1px solid #f1f5f9", background: "#eff6ff" }}>
        <Td mono>{user.username}{isSelf && <span style={{ marginRight: 6, fontSize: 11, color: "#2563eb" }}>(أنت)</span>}</Td>
        <Td>{user.displayName}</Td>
        <Td><RoleBadge role={user.role} /></Td>
        <Td colSpan={1}>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} style={ci} placeholder="كلمة المرور الجديدة *" />
        </Td>
        <Td>
          <button onClick={onSave} disabled={busy} style={btnSavSm}>{busy ? "..." : "حفظ"}</button>
          {" "}
          <button onClick={onCancel} disabled={busy} style={btnSecondary}>إلغاء</button>
        </Td>
      </tr>
      {err && <tr><td colSpan={5} style={{ padding: 10, background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>⚠️ {err}</td></tr>}
    </>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ textAlign: "right" as const, padding: "10px 14px", fontSize: 12, color: "#64748b", fontWeight: 600, ...style }}>{children}</th>;
}
function Td({ children, mono, colSpan }: { children: React.ReactNode; mono?: boolean; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ padding: "10px 14px", fontSize: 14, fontFamily: mono ? "ui-monospace, monospace" : undefined }}>{children}</td>;
}
function RoleBadge({ role }: { role: LocalUserRole }) {
  const cls = role === "admin" ? { bg: "#dbeafe", fg: "#1e40af", label: "مسؤول" } : { bg: "#f1f5f9", fg: "#475569", label: "كاشير" };
  return <span style={{ background: cls.bg, color: cls.fg, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{cls.label}</span>;
}

const input: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" };
const btnPrimary: React.CSSProperties = { padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { padding: "4px 10px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12 };
const btnLink: React.CSSProperties = { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 };
const btnSavSm: React.CSSProperties = { padding: "4px 10px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 };
