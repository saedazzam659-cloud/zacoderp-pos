import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { FileText, ArrowLeft, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { branchesApi } from "@/lib/branchesApi";
import { exportToExcel, exportToPDF, exportStatementToPDF, type ExportColumn } from "@/lib/export";
import { fmt2 } from "@/lib/format";
import { DateField } from "@/components/ui/date-field";
import AccountStatementView from "@/components/AccountStatementView";
import { useAuth } from "@/contexts/AuthContext";

export default function SisterCompanyStatement() {
  const { user } = useAuth() as any;
  const [, params] = useRoute<{ id: string }>("/inventory/sister-companies/:id/statement");
  const sid = Number(params?.id);
  const [from, setFrom] = useState<string>("");
  const [to,   setTo]   = useState<string>("");
  const [branchId, setBranchId] = useState<string>("");

  const { data: sister } = useQuery({
    queryKey: ["sister-company", sid],
    queryFn: () => sisterCompaniesApi.get(sid),
    enabled: !!sid,
  });
  const { data: branches = [] } = useQuery({ queryKey: ["branches"], queryFn: () => branchesApi.getBranches() });

  // Chart-of-accounts lookup so the statement can show the sister company's
  // linked GL account رمز الحساب (code) + مستوى الحساب (level) — the sister row
  // only carries `accountId`, not the code/level.
  const actingCompanyId = typeof window !== "undefined" ? localStorage.getItem("zatca_acting_company_id") : null;
  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts-for-sister-statement", actingCompanyId],
    queryFn: async () => {
      const token = localStorage.getItem("zatca_token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (actingCompanyId) headers["x-acting-company-id"] = actingCompanyId;
      const r = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/accounts?limit=2000`, { headers });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? j : (Array.isArray(j?.rows) ? j.rows : []);
    },
    enabled: !!user && sister?.accountId != null,
  });
  const linkedAccount = sister?.accountId != null
    ? (accounts as any[]).find((a) => a.id === sister.accountId) ?? null
    : null;
  const accountCode: string | null = linkedAccount?.code ?? null;
  const accountLevel: string | number | null = linkedAccount?.level ?? null;

  const { data: stmt, isLoading } = useQuery({
    queryKey: ["sister-statement", sid, from, to, branchId],
    queryFn: () => sisterCompaniesApi.statement(sid, from || undefined, to || undefined, branchId ? Number(branchId) : undefined),
    enabled: !!sid,
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2 print:hidden">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" /> كشف حساب — {sister?.nameAr ?? "…"}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {(() => {
            const cols: ExportColumn[] = [
              { header: "التاريخ", key: "date", width: 14 },
              { header: "المستند", key: "docNumber", width: 16 },
              { header: "النوع", key: "type", width: 16 },
              { header: "البيان", key: "description", width: 36 },
              { header: "مدين", key: "debit", width: 14 },
              { header: "دائن", key: "credit", width: 14 },
              { header: "الرصيد", key: "balance", width: 14 },
            ];
            const data = stmt ? [
              { date: "رمز الحساب", docNumber: accountCode ?? "—", type: "مستوى الحساب", description: accountLevel != null ? String(accountLevel) : "—", debit: "", credit: "", balance: "" },
              { date: "", docNumber: "", type: "", description: "الرصيد الافتتاحي", debit: "", credit: "", balance: Number(stmt.opening).toFixed(2) },
              ...stmt.rows.map((r: any) => ({
                date: r.date, docNumber: r.docNumber, type: r.type,
                description: r.description,
                debit:  r.debit  ? Number(r.debit ).toFixed(2) : "",
                credit: r.credit ? Number(r.credit).toFixed(2) : "",
                balance: Number(r.balance).toFixed(2),
              })),
            ] : [];
            const totals = stmt ? {
              date: "الرصيد الختامي",
              balance: Number(stmt.closing).toFixed(2),
            } : null;
            const title = `كشف حساب — ${sister?.nameAr ?? ""}`;
            const acctInfo = `رمز الحساب: ${accountCode ?? "—"} · مستوى الحساب: ${accountLevel != null ? String(accountLevel) : "—"}`;
            const periodInfo = (from || to) ? `الفترة: ${from || "—"} إلى ${to || "—"}` : "";
            const subtitle = [acctInfo, periodInfo].filter(Boolean).join("  •  ");
            const disabled = !stmt || data.length === 0;
            return (
              <>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => {
                    // When the company chose the "unified" statement print
                    // format, route the sister-company statement through the
                    // shared exportStatementToPDF renderer (mode "general") so
                    // it matches the customer/supplier printout. Otherwise keep
                    // the legacy window.print() (in-page AccountStatementView).
                    if (user?.company?.statementPrintFormat === "unified" && stmt) {
                      const totDebit  = stmt.rows.reduce((s: number, r: any) => s + (Number(r.debit)  || 0), 0);
                      const totCredit = stmt.rows.reduce((s: number, r: any) => s + (Number(r.credit) || 0), 0);
                      exportStatementToPDF({
                        mode: "general",
                        company: (user?.company as any) ?? null,
                        account: {
                          nameAr: sister?.nameAr ?? null,
                          nameEn: sister?.nameEn ?? null,
                          partyNameAr: sister?.nameAr ?? null,
                          partyNameEn: sister?.nameEn ?? null,
                          code: accountCode,
                          level: accountLevel,
                        },
                        from: from || "",
                        to: to || "",
                        opening: Number(stmt.opening) || 0,
                        lines: stmt.rows.map((r: any) => ({
                          date: r.date,
                          docType: r.type,
                          type: r.type,
                          docNumber: r.docNumber,
                          description: r.description,
                          debit: Number(r.debit) || 0,
                          credit: Number(r.credit) || 0,
                          balance: Number(r.balance) || 0,
                        })),
                        totals: { debit: totDebit, credit: totCredit },
                        closing: Number(stmt.closing) || 0,
                        filename: `sister-statement-${sid}`,
                        autoPrint: true,
                      });
                    } else {
                      window.print();
                    }
                  }}
                  data-testid="btn-print">
                  <Printer className="h-4 w-4 ml-1" /> طباعة
                </Button>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => exportToExcel(data, cols, `sister-statement-${sid}`, title, totals)}
                  data-testid="btn-export-excel">
                  <FileSpreadsheet className="h-4 w-4 ml-1" /> Excel
                </Button>
                <Button variant="outline" size="sm" disabled={disabled}
                  onClick={() => exportToPDF(data, cols, `sister-statement-${sid}`, title, subtitle, false, totals)}
                  data-testid="btn-export-pdf">
                  <FileDown className="h-4 w-4 ml-1" /> PDF
                </Button>
              </>
            );
          })()}
          <Link href="/inventory/sister-companies">
            <Button variant="outline"><ArrowLeft className="h-4 w-4 ml-1" /> رجوع</Button>
          </Link>
        </div>
      </div>

      <Card className="print:hidden"><CardContent className="flex flex-wrap gap-3 items-end pt-6">
        <label><span className="text-sm">من تاريخ</span>
          <DateField value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label><span className="text-sm">إلى تاريخ</span>
          <DateField value={to} onChange={e => setTo(e.target.value)} /></label>
        <label><span className="text-sm">الفرع</span>
          <select className="w-full border rounded h-9 px-2 min-w-[10rem]" value={branchId}
            onChange={e => setBranchId(e.target.value)} data-testid="select-branch">
            <option value="">كل الفروع</option>
            {(branches as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
          </select></label>
        <Button variant="outline" onClick={() => { setFrom(""); setTo(""); setBranchId(""); }}>إعادة تعيين</Button>
      </CardContent></Card>

      {/* Linked GL account identity — رمز الحساب + مستوى الحساب من شجرة الحسابات */}
      <Card className="print:hidden"><CardContent className="flex flex-wrap gap-x-8 gap-y-2 pt-6 text-sm">
        <div><span className="text-muted-foreground">الحساب: </span>
          <span className="font-semibold">{sister?.nameAr ?? "—"}</span></div>
        <div><span className="text-muted-foreground">رمز الحساب: </span>
          <span className="font-mono font-medium" data-testid="text-account-code">{accountCode ?? "—"}</span></div>
        <div><span className="text-muted-foreground">مستوى الحساب: </span>
          <span className="font-medium" data-testid="text-account-level">{accountLevel != null ? String(accountLevel) : "—"}</span></div>
      </CardContent></Card>

      <Card className="print:hidden"><CardContent className="p-0 overflow-x-auto">
        {isLoading || !stmt ? <div className="p-4"><Skeleton className="h-32" /></div> : (
          <table className="w-full text-sm" data-testid="table-statement">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 text-right">التاريخ</th>
              <th className="p-2 text-right">المستند</th>
              <th className="p-2 text-right">النوع</th>
              <th className="p-2 text-right">البيان</th>
              <th className="p-2 text-left">مدين</th>
              <th className="p-2 text-left">دائن</th>
              <th className="p-2 text-left">الرصيد</th>
            </tr></thead>
            <tbody>
              <tr className="border-t bg-muted/20 font-semibold">
                <td className="p-2" colSpan={6}>الرصيد الافتتاحي</td>
                <td className="p-2 text-left">{fmt2(stmt.opening)}</td>
              </tr>
              {stmt.rows.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">لا توجد حركات في الفترة</td></tr>
              )}
              {stmt.rows.map((r, i) => (
                <tr key={i} className="border-t hover:bg-muted/30">
                  <td className="p-2">{r.date}</td>
                  <td className="p-2 font-mono">{r.docNumber}</td>
                  <td className="p-2">{r.type}</td>
                  <td className="p-2 text-muted-foreground">{r.description}</td>
                  <td className="p-2 text-left">{r.debit  ? fmt2(r.debit) : ""}</td>
                  <td className="p-2 text-left">{r.credit ? fmt2(r.credit) : ""}</td>
                  <td className="p-2 text-left font-medium">{fmt2(r.balance)}</td>
                </tr>
              ))}
              <tr className="border-t bg-muted/20 font-bold">
                <td className="p-2" colSpan={6}>الرصيد الختامي</td>
                <td className="p-2 text-left">{fmt2(stmt.closing)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent></Card>

      {/* ── Unified printable statement (print only) ───────────────────
          Shares the exact same paper layout as the customer / supplier /
          general-accounts statements via AccountStatementView. The
          رقم القيد column is intentionally omitted from print. */}
      {stmt && (
        <div className="hidden print:block">
          <AccountStatementView
            mode="general"
            company={user?.company ?? null}
            account={{
              nameAr: sister?.nameAr ?? null,
              nameEn: sister?.nameEn ?? null,
              code: accountCode,
              level: accountLevel,
            }}
            from={from}
            to={to}
            opening={Number(stmt.opening) || 0}
            lines={stmt.rows.map((r: any) => ({
              id: r.id,
              journalEntryId: r.journalEntryId,
              date: r.date,
              docType: r.type,
              type: r.type,
              docNumber: r.docNumber,
              docHref: r.journalEntryId != null ? `/accounting/journals/${r.journalEntryId}` : undefined,
              journalEntryNumber: r.journalEntryNumber,
              description: r.description,
              debit: Number(r.debit) || 0,
              credit: Number(r.credit) || 0,
              balance: Number(r.balance) || 0,
            }))}
            totals={{
              debit:  stmt.rows.reduce((s: number, r: any) => s + (Number(r.debit)  || 0), 0),
              credit: stmt.rows.reduce((s: number, r: any) => s + (Number(r.credit) || 0), 0),
            }}
            closing={Number(stmt.closing) || 0}
          />
        </div>
      )}
    </div>
  );
}
