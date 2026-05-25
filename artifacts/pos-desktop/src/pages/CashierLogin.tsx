// Cashier login + branch + terminal picker — Task #175.
//
// Three sequential micro-steps inside a single screen:
//   1. Credentials  — companyCode + username + password
//                     → POST /api/auth/login  (issues userToken)
//   2. Branch pick  — only shown if the user is linked to >1 branch
//                     → GET  /api/org/branches?onlyUserBranches=1
//   3. Terminal pick → GET  /api/pos-terminals?branchId=X&activeOnly=1
//                     → POST /api/pos-sessions/open
//
// On success, persists:
//   * user token via tauri-shim's saveUserToken (keyring on Tauri)
//   * cashier context via saveCashierContext (localStorage — UI state only,
//     re-validated against /auth/me + /pos-sessions/current on next boot)
//
// The device must already be activated before this screen renders; the
// device token rides along on every cloud call here so the server can also
// pin the session to the physical terminal.

import { useEffect, useState } from "react";
import { createApi, ApiError, type Branch, type PosTerminal } from "../lib/api";
import {
  saveUserToken, clearUserToken, saveCashierContext, type CashierContext,
  getDeviceName, getFingerprint, TAURI_MODE,
} from "../lib/tauri-shim";

type Props = {
  baseUrl: string;
  deviceToken: string;
  // After login + session open, parent App switches to PosShell with this ctx.
  onSignedIn: (ctx: CashierContext, userToken: string) => void;
};

type Step = "creds" | "branch" | "terminal";

export default function CashierLogin({ baseUrl, deviceToken, onSignedIn }: Props) {
  const [step, setStep] = useState<Step>("creds");

  // ── Step 1: credentials ─────────────────────────────────────────────
  const [companyCode, setCompanyCode] = useState(() => localStorage.getItem("pos_desktop_last_company_code") ?? "");
  const [username, setUsername]       = useState(() => localStorage.getItem("pos_desktop_last_username") ?? "");
  const [password, setPassword]       = useState("");

  // ── Carried across steps after a successful login ───────────────────
  const [userToken, setUserToken] = useState<string | null>(null);
  const [userInfo, setUserInfo]   = useState<{
    userId: number; username: string; nameAr: string | null;
    companyId: number; companyName: string;
  } | null>(null);

  // ── Step 2: branches ────────────────────────────────────────────────
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<number | null>(null);

  // ── Step 3: terminals ───────────────────────────────────────────────
  const [terminals, setTerminals] = useState<PosTerminal[]>([]);
  const [terminalId, setTerminalId] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  // ─── Step 1 → 2 transition: log in, then load branches ──────────────
  async function submitCreds(e?: React.FormEvent) {
    e?.preventDefault();
    if (!companyCode.trim() || !username.trim() || !password) {
      setErr("الرجاء تعبئة كود الشركة واسم المستخدم وكلمة المرور");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const api = createApi({ baseUrl, deviceToken });
      const r = await api.cashierLogin({
        companyCode: companyCode.trim().toUpperCase(),
        username: username.trim(),
        password,
      });

      // Remember non-secret identifiers for the next boot's prefill.
      localStorage.setItem("pos_desktop_last_company_code", companyCode.trim().toUpperCase());
      localStorage.setItem("pos_desktop_last_username", username.trim());

      // IMPORTANT: do NOT persist the token to the keyring yet. If branch /
      // terminal selection fails or the user closes the window mid-flow, a
      // saved token without a CashierContext would leave the next boot in
      // an "orphan" state (token present, but App.tsx falls back to login
      // anyway, leaving stale credentials behind). We only saveUserToken
      // once openPosSession succeeds — see openSession() below.
      setUserToken(r.token);
      setUserInfo({
        userId: r.user.id,
        username: r.user.username,
        nameAr: r.user.nameAr,
        companyId: r.user.companyId ?? 0,
        companyName: r.user.company?.name ?? "",
      });

      // Load branches the user is linked to.
      const apiAuth = createApi({ baseUrl, deviceToken, userToken: r.token });
      const bs = await apiAuth.listBranches(true);

      if (bs.length === 0) {
        setErr("لا يوجد فرع مرتبط بحسابك. تواصل مع مدير النظام لربط الحساب بفرع.");
        setBusy(false); return;
      }
      setBranches(bs);

      if (bs.length === 1) {
        // Single-branch user — skip the picker and go straight to terminals.
        const b = bs[0];
        setBranchId(b.id);
        await loadTerminals(r.token, b.id);
      } else {
        setStep("branch");
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        const msg = (e.details as any)?.error ?? e.message;
        setErr(`${msg}`);
      } else {
        setErr(e?.message ?? "تعذّر تسجيل الدخول");
      }
    } finally { setBusy(false); }
  }

  // ─── Step 2 → 3 transition: load terminals for chosen branch ────────
  async function loadTerminals(tok: string, bid: number) {
    setBusy(true); setErr(null);
    try {
      const api = createApi({ baseUrl, deviceToken, userToken: tok });
      const ts = await api.listTerminals(bid);
      const active = ts.filter(t => t.isActive);
      setTerminals(active);
      if (active.length === 0) {
        setErr("لا توجد طُرق بيع مفعّلة في هذا الفرع. اطلب من المدير إضافة طريقة بيع.");
      }
      setStep("terminal");
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر تحميل طُرق البيع");
    } finally { setBusy(false); }
  }

  // ─── Step 3: open POS session and finish ────────────────────────────
  async function openSession() {
    if (!userToken || !userInfo || !branchId || !terminalId) return;
    const t = terminals.find(x => x.id === terminalId);
    if (!t) { setErr("اختر طريقة البيع أولاً"); return; }
    setBusy(true); setErr(null);
    try {
      const api = createApi({ baseUrl, deviceToken, userToken });
      const [deviceName, fp] = await Promise.all([getDeviceName(), getFingerprint()]);
      const session = await api.openPosSession({
        branchId,
        cashBoxId: t.cashBoxId ?? undefined,
        posTerminalId: t.id,
        machineCode: fp.slice(0, 64),
        device: deviceName,
        openingCash: 0,
      });
      const b = branches.find(x => x.id === branchId) ?? null;
      const ctx: CashierContext = {
        userId: userInfo.userId,
        username: userInfo.username,
        nameAr: userInfo.nameAr,
        companyId: userInfo.companyId,
        companyName: userInfo.companyName,
        branchId,
        branchName: b?.nameAr ?? null,
        posTerminalId: t.id,
        posTerminalName: t.nameAr,
        posSessionId: session.id,
        openedAt: session.openedAt,
      };
      // Atomically: persist the token, save the context, hand off. Saving
      // them together prevents the "orphan token, no context" boot state.
      await saveUserToken(userToken);
      saveCashierContext(ctx);
      onSignedIn(ctx, userToken);
    } catch (e: any) {
      if (e instanceof ApiError) {
        const msg = (e.details as any)?.error ?? e.message;
        setErr(`${msg}`);
      } else {
        setErr(e?.message ?? "تعذّر فتح وردية البيع");
      }
    } finally { setBusy(false); }
  }

  // Auto-pick the single available terminal so the cashier just confirms.
  useEffect(() => {
    if (step === "terminal" && terminals.length === 1 && terminalId == null) {
      setTerminalId(terminals[0].id);
    }
  }, [step, terminals, terminalId]);

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <div dir="rtl" style={S.wrap}>
      <header style={S.header}>
        <div style={S.brandIcon}>zacode</div>
        <div>
          <h1 style={S.title}>تسجيل دخول الكاشير</h1>
          <div style={S.sub}>
            {step === "creds"    && "أدخل بيانات حسابك السحابي للبدء"}
            {step === "branch"   && "اختر الفرع الذي تعمل به الآن"}
            {step === "terminal" && "اختر طريقة البيع (نقطة البيع)"}
          </div>
        </div>
      </header>

      <div style={S.progressRow}>
        <Dot active={step === "creds"} done={step !== "creds"} label="الحساب" />
        <Line />
        <Dot active={step === "branch"} done={step === "terminal"} label="الفرع" />
        <Line />
        <Dot active={step === "terminal"} done={false} label="طريقة البيع" />
      </div>

      <main style={S.main}>
        {step === "creds" && (
          <form onSubmit={submitCreds} style={S.form}>
            <Field label="كود الشركة">
              <input
                value={companyCode}
                onChange={(e) => setCompanyCode(e.target.value.toUpperCase())}
                placeholder="مثل: ZACOD"
                style={{ ...S.input, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}
                autoFocus
              />
            </Field>
            <Field label="اسم المستخدم">
              <input value={username} onChange={(e) => setUsername(e.target.value)} style={S.input} />
            </Field>
            <Field label="كلمة المرور">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={S.input} />
            </Field>

            {err && <div style={S.err}>⚠️ {err}</div>}

            <button type="submit" disabled={busy} style={S.btnPrimary}>
              {busy ? "جارٍ التحقق..." : "🔓 تسجيل الدخول"}
            </button>
          </form>
        )}

        {step === "branch" && (
          <div>
            <p style={S.lead}>أنت مرتبط بأكثر من فرع. اختر الفرع الذي ستعمل به في هذه الوردية:</p>
            <div style={S.grid}>
              {branches.map(b => (
                <button
                  key={b.id}
                  onClick={() => { setBranchId(b.id); if (userToken) loadTerminals(userToken, b.id); }}
                  style={S.cardBtn}
                  disabled={busy}
                >
                  <div style={S.cardIcon}>🏢</div>
                  <div style={S.cardName}>{b.nameAr}</div>
                  <div style={S.cardCode}>{b.code}</div>
                </button>
              ))}
            </div>
            {err && <div style={S.err}>⚠️ {err}</div>}
          </div>
        )}

        {step === "terminal" && (
          <div>
            <p style={S.lead}>
              الفرع: <strong>{branches.find(b => b.id === branchId)?.nameAr ?? "—"}</strong>
              <button onClick={() => { setStep("branch"); setTerminalId(null); }} style={S.linkBtn}>(تغيير)</button>
            </p>

            {terminals.length === 0 ? (
              <div style={S.empty}>لا توجد طُرق بيع متاحة. أضف واحدة من شاشة "طُرق البيع" في النظام السحابي.</div>
            ) : (
              <div style={S.grid}>
                {terminals.map(t => {
                  const busyBy = t.busyUserId != null && t.busyUserId !== userInfo?.userId;
                  return (
                    <button
                      key={t.id}
                      onClick={() => !busyBy && setTerminalId(t.id)}
                      disabled={busyBy || busy}
                      style={{
                        ...S.cardBtn,
                        ...(terminalId === t.id ? S.cardBtnActive : {}),
                        ...(busyBy ? S.cardBtnDisabled : {}),
                      }}
                      title={busyBy ? "مستخدمة الآن من قبل كاشير آخر" : undefined}
                    >
                      <div style={S.cardIcon}>{busyBy ? "🔒" : "💻"}</div>
                      <div style={S.cardName}>{t.nameAr}</div>
                      <div style={S.cardCode}>{t.code}</div>
                      {busyBy && <div style={S.busy}>مشغولة</div>}
                    </button>
                  );
                })}
              </div>
            )}

            {err && <div style={S.err}>⚠️ {err}</div>}

            <button onClick={openSession} disabled={busy || terminalId == null} style={{ ...S.btnPrimary, marginTop: 16 }}>
              {busy ? "جارٍ فتح الوردية..." : "✅ فتح الوردية والبدء"}
            </button>
          </div>
        )}
      </main>

      <footer style={S.footer}>
        <span>{TAURI_MODE === "tauri" ? "🪟 وضع التطبيق الأصلي" : "🌐 وضع المتصفح (تطوير)"}</span>
        <span style={{ color: "#94a3b8" }}>{baseUrl}</span>
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 14 }}>
    <div style={{ marginBottom: 6, fontWeight: 600, fontSize: 13, color: "#334155" }}>{label}</div>
    {children}
  </label>;
}

function Dot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  const bg = done ? "#16a34a" : active ? "#2563eb" : "#cbd5e1";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 999,
        background: bg, color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, fontWeight: 700,
      }}>{done ? "✓" : ""}</div>
      <div style={{ fontSize: 11, color: active || done ? "#0f172a" : "#94a3b8", fontWeight: 600 }}>{label}</div>
    </div>
  );
}
function Line() {
  return <div style={{ flex: 1, height: 2, background: "#e2e8f0", marginTop: 14 }} />;
}

const S = {
  wrap: {
    maxWidth: 560, margin: "40px auto", padding: 32,
    background: "#fff", borderRadius: 14, boxShadow: "0 10px 40px rgba(0,0,0,.08)",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  } as const,
  header: { display: "flex", gap: 14, alignItems: "center", marginBottom: 24 } as const,
  brandIcon: {
    width: 56, height: 56, borderRadius: 12,
    background: "linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)",
    color: "#fff", fontWeight: 800, fontSize: 13,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 4px 12px rgba(34,211,238,.3)",
  } as const,
  title: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub:   { fontSize: 13, color: "#64748b", marginTop: 2 } as const,
  progressRow: { display: "flex", alignItems: "flex-start", gap: 6, padding: "0 12px 24px" } as const,
  main: { minHeight: 280 } as const,
  form: { } as const,
  input: {
    width: "100%", padding: "10px 12px",
    border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14,
    boxSizing: "border-box" as const, fontFamily: "inherit",
  } as const,
  btnPrimary: {
    width: "100%", padding: "12px 24px",
    background: "linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%)",
    color: "#fff", border: "none", borderRadius: 8,
    cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit",
    boxShadow: "0 4px 12px rgba(37,99,235,.3)",
  } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, margin: "8px 0 12px", fontSize: 13 } as const,
  lead: { fontSize: 14, color: "#475569", margin: "0 0 16px" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 } as const,
  cardBtn: {
    background: "#fff", border: "2px solid #e2e8f0", borderRadius: 10,
    padding: "16px 12px", cursor: "pointer", textAlign: "center" as const,
    display: "flex", flexDirection: "column" as const, gap: 4,
    fontFamily: "inherit", transition: "all .12s",
  } as const,
  cardBtnActive: { borderColor: "#2563eb", background: "#eff6ff", boxShadow: "0 0 0 3px rgba(37,99,235,.1)" } as const,
  cardBtnDisabled: { opacity: 0.45, cursor: "not-allowed" } as const,
  cardIcon: { fontSize: 28 } as const,
  cardName: { fontSize: 14, fontWeight: 700, color: "#0f172a" } as const,
  cardCode: { fontSize: 11, color: "#64748b", fontFamily: "ui-monospace, monospace" } as const,
  busy: { fontSize: 10, color: "#dc2626", fontWeight: 700, marginTop: 4 } as const,
  empty: { padding: 32, textAlign: "center" as const, color: "#94a3b8", background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8 } as const,
  linkBtn: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontSize: 12, padding: "0 6px", fontFamily: "inherit" } as const,
  footer: { display: "flex", justifyContent: "space-between", marginTop: 24, paddingTop: 16, borderTop: "1px solid #e2e8f0", fontSize: 11, color: "#94a3b8" } as const,
};
