// تسجيل زاتكا (مستقل) — standalone ZATCA onboarding + submission status.
//
// Drives the device through the full EGS ladder WITHOUT the Zacod cloud:
// generate keypair + CSR → compliance CSID (OTP) → compliance checks →
// production CSID. Below the ladder it shows the local PIH/ICV chain and the
// per-invoice submission status, with a retry for any invoice left queued
// offline. Gated to country == "SA" by the caller (PosShell).

import { useCallback, useEffect, useState } from "react";
import {
  Page, Card, Field, ErrorMsg, input, btnPrimary, btnSecondary,
  Table, Th, Td, Empty,
} from "./_adminUi";
import { getCompanyProfile } from "../lib/appSettings";
import { getFingerprint } from "../lib/tauri-shim";
import {
  generateOnboardingCsr, exchangeComplianceCsid, exchangeProductionCsid,
  runComplianceCheck, type OnboardingOrg,
} from "../lib/zatca/onboarding";
import {
  zatcaGetOnboarding, zatcaListInvoices, zatcaChainHead, zatcaGetInvoice,
  type ZatcaOnboardingState, type ZatcaInvoiceRow, type ZatcaEnvironment,
} from "../lib/zatca/native";
import {
  loadActiveCredentials, submitSigned,
  type BuildInvoiceInput,
} from "../lib/zatca/submit";

const STATUS_LABEL: Record<string, string> = {
  none: "لم يبدأ",
  csr: "تم إنشاء المفتاح وطلب الشهادة",
  compliance: "تم إصدار شهادة الامتثال",
  production: "تم إصدار شهادة الإنتاج (جاهز)",
};
const INV_STATUS_LABEL: Record<string, string> = {
  pending: "بانتظار الإرسال",
  submitted: "تم الإرسال",
  rejected: "مرفوضة",
};

/** Minimal one-line simplified invoice from the company profile — used for the
 * pre-production compliance check submission. */
function buildSampleInvoice(uuid: string): BuildInvoiceInput {
  const p = getCompanyProfile();
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);
  const issueTime = now.toISOString().slice(11, 19);
  const number = `COMPL-${now.getTime()}`;
  const net = 100;
  const vat = 15;
  const gross = 115;
  return {
    uuid,
    invoiceNumber: number,
    flow: "simplified",
    issueDate,
    issueTime,
    currency: "SAR",
    qr: {
      sellerName: p.name || "Seller",
      vatNumber: p.vat || "300000000000003",
      invoiceTotal: gross.toFixed(2),
      vatTotal: vat.toFixed(2),
    },
    data: {
      invoiceNumber: number,
      issueDate,
      issueTime,
      supplyDate: issueDate,
      currency: "SAR",
      paymentMethod: "10",
      subtotal: net.toFixed(2),
      discountTotal: "0.00",
      vatTotal: vat.toFixed(2),
      grandTotal: gross.toFixed(2),
      notes: null,
      lineItems: [
        {
          id: 1,
          description: "Compliance sample item",
          quantity: "1",
          unitCode: "PCE",
          unitPrice: "100",
          discountAmount: "0",
          taxCategory: "S",
          vatRate: "15",
          vatAmount: "15.00",
          subtotal: "100.00",
          total: "115.00",
        },
      ],
      company: {
        nameAr: p.name || "المورد",
        nameEn: null,
        vatNumber: p.vat || "300000000000003",
        crNumber: p.cr || "0000000000",
        street: "غير محدد",
        buildingNumber: "0000",
        city: "الرياض",
        district: null,
        postalCode: "00000",
        country: "SA",
      },
      customer: null,
    },
  };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuidV4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function ZatcaOnboarding() {
  const [onb, setOnb] = useState<ZatcaOnboardingState | null>(null);
  const [invoices, setInvoices] = useState<ZatcaInvoiceRow[]>([]);
  const [head, setHead] = useState<{ icv: number; invoiceHash: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // CSR form
  const [env, setEnv] = useState<ZatcaEnvironment>("sandbox");
  const [orgName, setOrgName] = useState("");
  const [orgUnit, setOrgUnit] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [serial, setSerial] = useState("");
  const [invType, setInvType] = useState("simplified");
  const [otp, setOtp] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [o, inv, h] = await Promise.all([
        zatcaGetOnboarding(),
        zatcaListInvoices(),
        zatcaChainHead(),
      ]);
      setOnb(o);
      setInvoices(inv);
      setHead(h);
      if (o.environment) setEnv(o.environment);
      if (o.orgJson) {
        try {
          const org = JSON.parse(o.orgJson) as OnboardingOrg;
          setOrgName((v) => v || org.organizationName || "");
          setOrgUnit((v) => v || org.organizationUnit || "");
          setVatNumber((v) => v || org.vatNumber || "");
          setSerial((v) => v || org.serialNumber || "");
          setInvType(org.invoiceType || "simplified");
        } catch { /* ignore */ }
      } else {
        const p = getCompanyProfile();
        setOrgName((v) => v || p.name || "");
        setVatNumber((v) => v || p.vat || "");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setErr(null); setMsg(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Auto-fill org name + VAT from the company profile, default the branch, and
  // generate a stable EGS serial from the device fingerprint (same machine →
  // same serial, so re-onboarding stays consistent). One-click convenience.
  const autoFill = useCallback(async () => {
    setErr(null); setMsg(null);
    try {
      const p = getCompanyProfile();
      if (p.name) setOrgName(p.name);
      if (p.vat) setVatNumber(p.vat);
      setOrgUnit((v) => v || "الفرع الرئيسي");
      let seed = (await getFingerprint())?.trim() || "";
      if (!seed) {
        const KEY = "pos_desktop_egs_seed";
        seed = localStorage.getItem(KEY) || "";
        if (!seed) { seed = uuidV4(); localStorage.setItem(KEY, seed); }
      }
      const short = (await sha256Hex(seed)).slice(0, 12).toUpperCase();
      setSerial(`1-Zacod|2-POS|3-${short}`);
      setMsg("تم ملء البيانات تلقائياً — راجعها ثم اضغط «إنشاء المفتاح + CSR».");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const status = onb?.status ?? "none";
  const hasCsr = status === "csr" || status === "compliance" || status === "production";
  const hasCompliance = status === "compliance" || status === "production";
  const hasProduction = status === "production";

  return (
    <div style={{ padding: 16 }}>
      <Page title="تسجيل زاتكا (مستقل)" subtitle="إصدار الشهادات والتوقيع والإرسال المباشر إلى هيئة الزكاة والضريبة والجمارك — بدون سحابة">
        <ErrorMsg text={err} />
        {msg && <div style={{ color: "#166534", marginBottom: 12 }}>{msg}</div>}

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <div><b>الحالة:</b> {STATUS_LABEL[status] ?? status}</div>
            <div><b>البيئة:</b> {onb?.environment === "production" ? "الإنتاج" : "الاختبار (Sandbox)"}</div>
            {head && <div><b>آخر تسلسل (ICV):</b> {head.icv}</div>}
            {onb?.lastError && <div style={{ color: "#991b1b" }}><b>آخر خطأ:</b> {onb.lastError}</div>}
          </div>
        </Card>

        {/* Step 1 — CSR */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>1) إنشاء المفتاح وطلب الشهادة (CSR)</h3>
            <button style={btnSecondary} disabled={!!busy} onClick={() => void autoFill()}>
              ⚡ ملء تلقائي
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="اسم المنشأة">
              <input style={input} value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </Field>
            <Field label="الوحدة / الفرع">
              <input style={input} value={orgUnit} onChange={(e) => setOrgUnit(e.target.value)} />
            </Field>
            <Field label="الرقم الضريبي (15 رقمًا)">
              <input style={input} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
            </Field>
            <Field label="الرقم التسلسلي للجهاز (EGS)">
              <input style={input} value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="1-Zacod|2-POS|3-..." />
            </Field>
            <Field label="نوع الفواتير">
              <select style={input} value={invType} onChange={(e) => setInvType(e.target.value)}>
                <option value="simplified">مبسطة (B2C)</option>
                <option value="standard">ضريبية (B2B)</option>
                <option value="both">كلاهما</option>
              </select>
            </Field>
            <Field label="البيئة">
              <select style={input} value={env} onChange={(e) => setEnv(e.target.value as ZatcaEnvironment)}>
                <option value="sandbox">الاختبار (Sandbox)</option>
                <option value="production">الإنتاج</option>
              </select>
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              style={btnPrimary}
              disabled={!!busy || !orgName || !vatNumber || !serial}
              onClick={() => run("csr", async () => {
                await generateOnboardingCsr(
                  { organizationName: orgName, organizationUnit: orgUnit, vatNumber, serialNumber: serial, invoiceType: invType },
                  env,
                );
                setMsg("تم إنشاء المفتاح وطلب الشهادة بنجاح.");
              })}
            >
              {busy === "csr" ? "جارٍ الإنشاء…" : hasCsr ? "إعادة إنشاء المفتاح / CSR" : "إنشاء المفتاح + CSR"}
            </button>
            {onb?.csrPem && (
              <button style={{ ...btnSecondary, marginInlineStart: 8 }} onClick={() => navigator.clipboard?.writeText(onb.csrPem ?? "")}>
                نسخ CSR
              </button>
            )}
          </div>
        </Card>

        {/* Step 2 — compliance CSID via OTP */}
        <Card style={{ marginBottom: 16, opacity: hasCsr ? 1 : 0.5 }}>
          <h3 style={{ marginTop: 0 }}>2) شهادة الامتثال (OTP)</h3>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <Field label="رمز التحقق (OTP) من بوابة فاتورة" style={{ maxWidth: 260 }}>
              <input style={input} value={otp} onChange={(e) => setOtp(e.target.value)} />
            </Field>
            <button
              style={btnPrimary}
              disabled={!!busy || !hasCsr || !otp.trim()}
              onClick={() => run("compliance", async () => {
                await exchangeComplianceCsid(otp);
                setOtp("");
                setMsg("تم إصدار شهادة الامتثال.");
              })}
            >
              {busy === "compliance" ? "جارٍ الإصدار…" : "إصدار شهادة الامتثال"}
            </button>
          </div>
        </Card>

        {/* Step 3 — compliance checks */}
        <Card style={{ marginBottom: 16, opacity: hasCompliance ? 1 : 0.5 }}>
          <h3 style={{ marginTop: 0 }}>3) فحوصات الامتثال</h3>
          <p style={{ color: "#475569", marginTop: 0 }}>
            إرسال فاتورة عينة موقّعة إلى مسار الامتثال للتحقق قبل إصدار شهادة الإنتاج.
          </p>
          <button
            style={btnPrimary}
            disabled={!!busy || !hasCompliance}
            onClick={() => run("check", async () => {
              const r = await runComplianceCheck(buildSampleInvoice(uuidV4()));
              setMsg(r.ok ? `نجح فحص الامتثال (${r.zatcaStatus ?? "OK"}).` : `استجابة الفحص: ${r.zatcaStatus ?? "غير معروف"}`);
            })}
          >
            {busy === "check" ? "جارٍ الفحص…" : "تشغيل فحص الامتثال"}
          </button>
        </Card>

        {/* Step 4 — production CSID */}
        <Card style={{ marginBottom: 16, opacity: hasCompliance ? 1 : 0.5 }}>
          <h3 style={{ marginTop: 0 }}>4) شهادة الإنتاج</h3>
          <button
            style={btnPrimary}
            disabled={!!busy || !hasCompliance}
            onClick={() => run("production", async () => {
              await exchangeProductionCsid();
              setMsg("تم إصدار شهادة الإنتاج — الجهاز جاهز للإرسال المباشر.");
            })}
          >
            {busy === "production" ? "جارٍ الإصدار…" : hasProduction ? "إعادة إصدار شهادة الإنتاج" : "إصدار شهادة الإنتاج"}
          </button>
        </Card>

        {/* Local chain + statuses */}
        <Card>
          <h3 style={{ marginTop: 0 }}>سجل الفواتير المرسلة إلى زاتكا</h3>
          {invoices.length === 0 ? (
            <Empty text="لا توجد فواتير في سلسلة زاتكا بعد." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>ICV</Th>
                  <Th>رقم الفاتورة</Th>
                  <Th>النوع</Th>
                  <Th>الحالة</Th>
                  <Th>حالة زاتكا</Th>
                  <Th>إجراء</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((iv) => (
                  <tr key={iv.localUuid}>
                    <Td num>{iv.icv}</Td>
                    <Td>{iv.invoiceNo ?? "—"}</Td>
                    <Td>{iv.invoiceType === "standard" ? "ضريبية" : "مبسطة"}</Td>
                    <Td>{INV_STATUS_LABEL[iv.status] ?? iv.status}</Td>
                    <Td>{iv.zatcaStatus ?? "—"}</Td>
                    <Td>
                      {iv.status === "pending" && (
                        <button
                          style={btnSecondary}
                          disabled={!!busy}
                          onClick={() => run(`retry-${iv.localUuid}`, async () => {
                            const creds = await loadActiveCredentials();
                            const full = await zatcaGetInvoice(iv.localUuid);
                            if (!full?.signedXml) throw new Error("فاتورة موقّعة غير متوفرة لإعادة الإرسال");
                            await submitSigned(creds, {
                              uuid: full.localUuid,
                              icv: full.icv,
                              pih: full.pih,
                              invoiceHash: full.invoiceHash,
                              signedXml: full.signedXml,
                              qrBase64: full.qrBase64 ?? "",
                              flow: full.invoiceType === "standard" ? "standard" : "simplified",
                              invoiceNumber: full.invoiceNo ?? "",
                            });
                            setMsg("تمت إعادة محاولة الإرسال.");
                          })}
                        >
                          إعادة الإرسال
                        </button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Page>
    </div>
  );
}
