import { saveBlob } from "@/lib/saveFile";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  CheckCircle2, XCircle, Clock, FileBarChart, Download, Filter,
  TrendingUp, AlertCircle, Search,
} from "lucide-react";
import BranchFilter from "@/components/BranchFilter";
import { useTranslation } from "react-i18next";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Row = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  customerNameAr: string | null;
  customerNameEn?: string | null;
  customerVatNumber: string | null;
  totalAmount: string | number;
  vatAmount: string | number;
  status: string;
  zatcaStatus: "pending" | "approved" | "rejected" | null;
  zatcaSubmittedAt: string | null;
  zatcaUuid: string | null;
  zatcaErrorMessages: string | null;
  zatcaResponseCode: string | null;
};

const COLORS = { approved: "#10b981", rejected: "#ef4444", pending: "#f59e0b" };

export default function ZatcaReport() {
  const { user, token } = useAuth();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`zatcaPages.report.${k}`, opts) as string;
  const locale = isRtl ? "ar-SA" : "en-US";
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const [, navigate] = useLocation();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH = { Authorization: `Bearer ${token}` };

  // Default range: last 30 days
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(monthAgo);
  const [dateTo, setDateTo] = useState(today);
  const [statusFilter, setStatusFilter] = useState<"all" | "approved" | "rejected" | "pending">("all");
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState<number | undefined>(undefined);

  const url = (() => {
    const params = new URLSearchParams();
    if (cid) params.set("companyId", String(cid));
    if (branchId) params.set("branchId", String(branchId));
    const qs = params.toString();
    return `${API}/api/sales/sales-invoices-zatca-bridge${qs ? `?${qs}` : ""}`;
  })();

  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: ["zatca-report", cid, branchId],
    queryFn: async () => {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  // Filter by date range + status + search
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter(r => {
      const d = (r.invoiceDate || "").slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      const st = r.zatcaStatus || "pending";
      if (statusFilter !== "all" && st !== statusFilter) return false;
      if (s) {
        const ok = (r.docNumber ?? "").toLowerCase().includes(s)
          || (r.customerNameAr ?? "").toLowerCase().includes(s)
          || (r.customerNameEn ?? "").toLowerCase().includes(s)
          || (r.customerVatNumber ?? "").toLowerCase().includes(s)
          || (r.zatcaUuid ?? "").toLowerCase().includes(s);
        if (!ok) return false;
      }
      return true;
    });
  }, [rows, dateFrom, dateTo, statusFilter, search]);

  // ─── KPIs (computed on filtered set) ─────────────────────────────────
  const kpis = useMemo(() => {
    const sumAmt = (arr: Row[]) => arr.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    const sumVat = (arr: Row[]) => arr.reduce((s, r) => s + Number(r.vatAmount || 0), 0);
    const a = filtered.filter(r => r.zatcaStatus === "approved");
    const r0 = filtered.filter(r => r.zatcaStatus === "rejected");
    const p = filtered.filter(r => !r.zatcaStatus || r.zatcaStatus === "pending");
    const total = filtered.length;
    const submitted = a.length + r0.length;
    return {
      total,
      approved: a.length,
      rejected: r0.length,
      pending: p.length,
      approvedAmount: sumAmt(a),
      rejectedAmount: sumAmt(r0),
      approvedVat: sumVat(a),
      acceptanceRate: submitted > 0 ? (a.length / submitted) * 100 : 0,
    };
  }, [filtered]);

  // ─── Pie chart data ──────────────────────────────────────────────────
  const pieData = [
    { name: tr("statusApproved"), value: kpis.approved, color: COLORS.approved },
    { name: tr("statusRejected"), value: kpis.rejected, color: COLORS.rejected },
    { name: tr("statusPending"),  value: kpis.pending,  color: COLORS.pending },
  ].filter(d => d.value > 0);

  // ─── Daily trend chart ───────────────────────────────────────────────
  const trendData = useMemo(() => {
    const map = new Map<string, { date: string; approved: number; rejected: number; pending: number }>();
    filtered.forEach(r => {
      const d = (r.invoiceDate || "").slice(0, 10);
      if (!map.has(d)) map.set(d, { date: d, approved: 0, rejected: 0, pending: 0 });
      const row = map.get(d)!;
      const st = r.zatcaStatus || "pending";
      if (st === "approved") row.approved++;
      else if (st === "rejected") row.rejected++;
      else row.pending++;
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filtered]);

  // ─── Top rejection reasons ───────────────────────────────────────────
  const topReasons = useMemo(() => {
    const counts = new Map<string, { code: string; message: string; count: number }>();
    filtered.filter(r => r.zatcaStatus === "rejected").forEach(r => {
      try {
        const errs = JSON.parse(r.zatcaErrorMessages || "[]") as { code: string; message: string }[];
        errs.forEach(e => {
          const k = e.code;
          if (!counts.has(k)) counts.set(k, { code: e.code, message: e.message, count: 0 });
          counts.get(k)!.count++;
        });
      } catch { /* ignore */ }
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  }, [filtered]);

  const fmtMoney = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ─── CSV Export ──────────────────────────────────────────────────────
  const exportCsv = () => {
    const headers = [
      tr("exportHeaderInvoice"),
      tr("exportHeaderDate"),
      tr("exportHeaderCustomer"),
      tr("exportHeaderVatNum"),
      tr("exportHeaderTotal"),
      tr("exportHeaderVat"),
      tr("exportHeaderStatus"),
      tr("exportHeaderUuid"),
      tr("exportHeaderSubmittedAt"),
      tr("exportHeaderReasons"),
    ];
    const lines = filtered.map(r => {
      let reasons = "";
      try {
        const errs = JSON.parse(r.zatcaErrorMessages || "[]") as { code: string; message: string }[];
        reasons = errs.map(e => `[${e.code}] ${e.message}`).join(" | ");
      } catch { /* ignore */ }
      const status = r.zatcaStatus === "approved" ? tr("statusApproved")
                   : r.zatcaStatus === "rejected" ? tr("statusRejected")
                   : tr("statusPending");
      const cells = [
        r.docNumber || `#${r.id}`,
        (r.invoiceDate || "").slice(0, 10),
        pickName(r.customerNameAr, r.customerNameEn) || tr("cashCustomerExport"),
        r.customerVatNumber || "",
        Number(r.totalAmount || 0).toFixed(2),
        Number(r.vatAmount || 0).toFixed(2),
        status,
        r.zatcaUuid || "",
        r.zatcaSubmittedAt ? new Date(r.zatcaSubmittedAt).toLocaleString(locale) : "",
        reasons,
      ].map(c => `"${String(c).replace(/"/g, '""')}"`);
      return cells.join(",");
    });
    const csv = "\uFEFF" + headers.join(",") + "\n" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    void saveBlob(blob, `${tr("exportFilenamePrefix")}-${dateFrom}_to_${dateTo}.csv`);
  };

  return (
    <div className="p-6 space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 text-white">
            <FileBarChart className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{tr("title")}</h1>
            <p className="text-sm text-muted-foreground">{tr("subtitle")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0} className="gap-2">
            <Download className="h-4 w-4" />
            {tr("exportButton")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />
            {tr("filtersTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div>
              <Label className="text-xs">{tr("from")}</Label>
              <DateField value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">{tr("to")}</Label>
              <DateField value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">{tr("branch")}</Label>
              <BranchFilter value={branchId} onChange={setBranchId} />
            </div>
            <div>
              <Label className="text-xs">{tr("status")}</Label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="all">{tr("statusAll")}</option>
                <option value="approved">{tr("statusApprovedOnly")}</option>
                <option value="rejected">{tr("statusRejectedOnly")}</option>
                <option value="pending">{tr("statusPendingOnly")}</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">{tr("search")}</Label>
              <div className="relative">
                <Search className={`h-4 w-4 absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 text-muted-foreground`} />
                <Input
                  placeholder={tr("searchPh")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={isRtl ? "pr-9" : "pl-9"}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">{tr("kpiTotal")}</div>
            <div className="text-2xl font-bold mt-1">{kpis.total}</div>
            <div className="text-xs text-muted-foreground mt-1">{tr("kpiInRange")}</div>
          </CardContent>
        </Card>

        <Card className="bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div className="text-xs text-emerald-700 dark:text-emerald-300">{tr("kpiApproved")}</div>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">{kpis.approved}</div>
            <div className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">{fmtMoney(kpis.approvedAmount)} {isRtl ? "ر.س" : "SAR"}</div>
          </CardContent>
        </Card>

        <Card className="bg-red-50/50 dark:bg-red-950/20 border-red-200">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div className="text-xs text-red-700 dark:text-red-300">{tr("kpiRejected")}</div>
              <XCircle className="h-4 w-4 text-red-500" />
            </div>
            <div className="text-2xl font-bold mt-1 text-red-600 dark:text-red-400">{kpis.rejected}</div>
            <div className="text-xs text-red-700 dark:text-red-300 mt-1">{fmtMoney(kpis.rejectedAmount)} {isRtl ? "ر.س" : "SAR"}</div>
          </CardContent>
        </Card>

        <Card className="bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-200">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div className="text-xs text-indigo-700 dark:text-indigo-300">{tr("kpiAcceptanceRate")}</div>
              <TrendingUp className="h-4 w-4 text-indigo-500" />
            </div>
            <div className="text-2xl font-bold mt-1 text-indigo-600 dark:text-indigo-400">
              {kpis.acceptanceRate.toFixed(1)}%
            </div>
            <div className="text-xs text-indigo-700 dark:text-indigo-300 mt-1">
              {tr("kpiApprovedVat", { value: fmtMoney(kpis.approvedVat) })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Pie chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr("chartPie")}</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                {tr("noData")}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(e: any) => `${e.name}: ${e.value}`}
                  >
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Daily trend */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{tr("chartTrend")}</CardTitle>
          </CardHeader>
          <CardContent>
            {trendData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                {tr("noData")}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="approved" stackId="a" fill={COLORS.approved} name={tr("statusApproved")} />
                  <Bar dataKey="rejected" stackId="a" fill={COLORS.rejected} name={tr("statusRejected")} />
                  <Bar dataKey="pending" stackId="a" fill={COLORS.pending} name={tr("statusPending")} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top rejection reasons */}
      {topReasons.length > 0 && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-red-700">
              <AlertCircle className="h-4 w-4" />
              {tr("topReasons")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {topReasons.map((r) => (
                <div key={r.code} className="flex items-start justify-between gap-3 p-3 rounded-lg bg-red-50/50 dark:bg-red-950/20 border border-red-200">
                  <div className="flex-1">
                    <div className="text-xs font-mono text-red-600 mb-0.5">{r.code}</div>
                    <div className="text-sm">{r.message}</div>
                  </div>
                  <Badge variant="outline" className="bg-red-100 text-red-700 border-red-300 shrink-0">
                    {r.count}×
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detailed table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("listTitle", { count: filtered.length })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">{tr("loading")}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileBarChart className="h-10 w-10 mx-auto mb-2 opacity-30" />
              {tr("noInvoicesInFilter")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colInvoiceNumber")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colDate")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colCustomer")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colTotal")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colVat")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colZatcaStatus")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colSubmittedAt")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colUuidReason")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const status = row.zatcaStatus || "pending";
                    let reasons: { code: string; message: string }[] = [];
                    try { reasons = JSON.parse(row.zatcaErrorMessages || "[]"); } catch { /* ignore */ }
                    const customerLabel = pickName(row.customerNameAr, row.customerNameEn);
                    return (
                      <TableRow
                        key={row.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => navigate(`/sales/invoices/${row.id}`)}
                      >
                        <TableCell className="font-mono">{row.docNumber || `#${row.id}`}</TableCell>
                        <TableCell>{row.invoiceDate?.slice(0, 10)}</TableCell>
                        <TableCell>{customerLabel || <span className="text-muted-foreground">{tr("cashCustomer")}</span>}</TableCell>
                        <TableCell className="font-semibold">{fmtMoney(Number(row.totalAmount || 0))}</TableCell>
                        <TableCell>{fmtMoney(Number(row.vatAmount || 0))}</TableCell>
                        <TableCell>
                          {status === "approved" && (
                            <Badge className="bg-emerald-600 text-white gap-1">
                              <CheckCircle2 className="h-3 w-3" /> {tr("statusApproved")}
                            </Badge>
                          )}
                          {status === "rejected" && (
                            <Badge className="bg-red-600 text-white gap-1">
                              <XCircle className="h-3 w-3" /> {tr("statusRejected")}
                            </Badge>
                          )}
                          {status === "pending" && (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 gap-1">
                              <Clock className="h-3 w-3" /> {tr("statusPending")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.zatcaSubmittedAt ? new Date(row.zatcaSubmittedAt).toLocaleString(locale) : "—"}
                        </TableCell>
                        <TableCell className="text-xs max-w-xs">
                          {status === "approved" && row.zatcaUuid && (
                            <span className="font-mono text-emerald-600 truncate block" title={row.zatcaUuid}>
                              {row.zatcaUuid}
                            </span>
                          )}
                          {status === "rejected" && reasons.length > 0 && (
                            <span className="text-red-600 truncate block" title={reasons.map(r => r.message).join(" | ")}>
                              {reasons[0].message}
                              {reasons.length > 1 && <span className="text-muted-foreground"> (+{reasons.length - 1})</span>}
                            </span>
                          )}
                          {status === "pending" && <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
