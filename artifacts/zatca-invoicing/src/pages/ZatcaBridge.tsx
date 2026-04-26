import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2, XCircle, Clock, Send, Sparkles, ArrowLeftRight,
  Search, FileText, Loader2, AlertTriangle, ChevronLeft, ChevronRight,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type BridgeRow = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  customerId: number | null;
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
  zatcaWarningMessages: string | null;
  zatcaResponseCode: string | null;
};

type ZatcaError = { code: string; message: string };
type AiExplain = { explanation: string; fixes: string[]; summary: string; source: "ai" | "rules" };

export default function ZatcaBridge() {
  const { user, token } = useAuth();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`zatcaPages.bridge.${k}`, opts) as string;
  const locale = isRtl ? "ar-SA" : "en-US";
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "approved" | "rejected" | "pending">("all");
  const [dialogRow, setDialogRow] = useState<BridgeRow | null>(null);
  const [aiData, setAiData] = useState<AiExplain | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const url = cid
    ? `${API}/api/sales/sales-invoices-zatca-bridge?companyId=${cid}`
    : `${API}/api/sales/sales-invoices-zatca-bridge`;

  const { data: rows = [], isLoading } = useQuery<BridgeRow[]>({
    queryKey: ["zatca-bridge", cid],
    queryFn: async () => {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const submit = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/sales/sales-invoices/${id}/zatca-submit`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || tr("submitFailed"));
      return data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["zatca-bridge", cid] });
      if (data.status === "approved") {
        toast({ title: tr("approvedToast"), description: tr("approvedToastDesc", { uuid: data.uuid }) });
      } else {
        toast({ title: tr("rejectedToast"), description: tr("rejectedToastDesc", { count: data.errors?.length || 0 }), variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: tr("errorToast"), description: e.message, variant: "destructive" }),
  });

  const stats = useMemo(() => {
    const a = rows.filter(r => r.zatcaStatus === "approved").length;
    const r0 = rows.filter(r => r.zatcaStatus === "rejected").length;
    const p = rows.filter(r => !r.zatcaStatus || r.zatcaStatus === "pending").length;
    return { approved: a, rejected: r0, pending: p, total: rows.length };
  }, [rows]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter(r => {
      if (filter !== "all") {
        const status = r.zatcaStatus || "pending";
        if (status !== filter) return false;
      }
      if (!s) return true;
      return (
        (r.docNumber ?? "").toLowerCase().includes(s) ||
        (r.customerNameAr ?? "").toLowerCase().includes(s) ||
        (r.customerNameEn ?? "").toLowerCase().includes(s) ||
        (r.customerVatNumber ?? "").toLowerCase().includes(s)
      );
    });
  }, [rows, search, filter]);

  const openRejection = async (row: BridgeRow) => {
    setDialogRow(row);
    setAiData(null);
    let errors: ZatcaError[] = [];
    try { errors = JSON.parse(row.zatcaErrorMessages || "[]"); } catch { errors = []; }
    if (!errors.length) return;

    setAiLoading(true);
    try {
      const r = await fetch(`${API}/api/ai/explain-zatca-rejection`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice: {
            docNumber: row.docNumber,
            invoiceDate: row.invoiceDate,
            totalAmount: row.totalAmount,
            vatAmount: row.vatAmount,
            status: row.status,
            customer: row.customerNameAr || row.customerNameEn ? {
              nameAr: row.customerNameAr,
              nameEn: row.customerNameEn,
              vatNumber: row.customerVatNumber,
            } : null,
          },
          errors,
        }),
      });
      const data = await r.json();
      if (r.ok) setAiData(data);
    } catch {
      // silent — dialog will still show raw errors
    } finally {
      setAiLoading(false);
    }
  };

  const parseErrors = (s: string | null): ZatcaError[] => {
    if (!s) return [];
    try { return JSON.parse(s); } catch { return []; }
  };

  const fmtMoney = (v: any) => Number(v || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const ChevronEnd = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div className="p-6 space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 text-white">
            <ArrowLeftRight className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{tr("title")}</h1>
            <p className="text-sm text-muted-foreground">{tr("subtitle")}</p>
          </div>
        </div>
      </div>

      {/* Stats — approved/rejected/pending counters (clickable filters) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card
          className={`cursor-pointer transition border-2 ${filter === "all" ? "border-indigo-500" : "border-transparent"}`}
          onClick={() => setFilter("all")}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">{tr("kpiTotal")}</div>
                <div className="text-3xl font-bold mt-1">{stats.total}</div>
              </div>
              <FileText className="h-10 w-10 text-muted-foreground/40" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer transition border-2 ${filter === "approved" ? "border-emerald-500" : "border-transparent"} bg-emerald-50/50 dark:bg-emerald-950/20`}
          onClick={() => setFilter("approved")}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-emerald-700 dark:text-emerald-300">{tr("kpiApproved")}</div>
                <div className="text-3xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">{stats.approved}</div>
              </div>
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer transition border-2 ${filter === "rejected" ? "border-red-500" : "border-transparent"} bg-red-50/50 dark:bg-red-950/20`}
          onClick={() => setFilter("rejected")}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-red-700 dark:text-red-300">{tr("kpiRejected")}</div>
                <div className="text-3xl font-bold mt-1 text-red-600 dark:text-red-400">{stats.rejected}</div>
              </div>
              <XCircle className="h-10 w-10 text-red-500" />
            </div>
          </CardContent>
        </Card>

        <Card
          className={`cursor-pointer transition border-2 ${filter === "pending" ? "border-amber-500" : "border-transparent"} bg-amber-50/50 dark:bg-amber-950/20`}
          onClick={() => setFilter("pending")}
        >
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-amber-700 dark:text-amber-300">{tr("kpiPending")}</div>
                <div className="text-3xl font-bold mt-1 text-amber-600 dark:text-amber-400">{stats.pending}</div>
              </div>
              <Clock className="h-10 w-10 text-amber-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-lg">{tr("salesInvoices")}</CardTitle>
            <div className="relative w-full md:w-80">
              <Search className={`h-4 w-4 absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 text-muted-foreground`} />
              <Input
                placeholder={tr("searchPh")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={isRtl ? "pr-9" : "pl-9"}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin inline-block ml-2" /> {tr("loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-2 opacity-30" />
              {tr("noInvoices")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colInvoiceNumber")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colDate")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colCustomer")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colVatNumber")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colTotal")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colPosting")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colZatcaStatus")}</TableHead>
                    <TableHead className={isRtl ? "text-right" : "text-left"}>{tr("colAction")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const status = row.zatcaStatus || "pending";
                    const errors = parseErrors(row.zatcaErrorMessages);
                    const customerLabel = pickName(row.customerNameAr, row.customerNameEn);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono">{row.docNumber || `#${row.id}`}</TableCell>
                        <TableCell>{row.invoiceDate?.slice(0, 10)}</TableCell>
                        <TableCell>{customerLabel || <span className="text-muted-foreground">{tr("cashCustomer")}</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{row.customerVatNumber || "—"}</TableCell>
                        <TableCell className="font-semibold">{fmtMoney(row.totalAmount)} {isRtl ? "ر.س" : "SAR"}</TableCell>
                        <TableCell>
                          {row.status === "posted" ? (
                            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950 dark:text-blue-300">{tr("posted")}</Badge>
                          ) : (
                            <Badge variant="outline" className="bg-gray-50 text-gray-600">{tr("draft")}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {status === "approved" && (
                            <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1">
                              <CheckCircle2 className="h-3 w-3" /> {tr("statusApproved")}
                            </Badge>
                          )}
                          {status === "rejected" && (
                            <Badge
                              className="bg-red-600 hover:bg-red-700 text-white gap-1 cursor-pointer"
                              onClick={() => openRejection(row)}
                              title={tr("statusRejectedClickHint")}
                            >
                              <XCircle className="h-3 w-3" /> {tr("statusRejected", { count: errors.length })}
                            </Badge>
                          )}
                          {status === "pending" && (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 gap-1">
                              <Clock className="h-3 w-3" /> {tr("statusPending")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant={status === "rejected" ? "outline" : "default"}
                            disabled={submit.isPending}
                            onClick={() => submit.mutate(row.id)}
                            className="gap-1"
                          >
                            <Send className="h-3.5 w-3.5" />
                            {status === "pending" ? tr("btnSubmit") : tr("btnResubmit")}
                          </Button>
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

      {/* Rejection Dialog with AI explanation */}
      <Dialog open={!!dialogRow} onOpenChange={(o) => { if (!o) { setDialogRow(null); setAiData(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              {tr("dialogTitle", { number: dialogRow?.docNumber || `#${dialogRow?.id}` })}
            </DialogTitle>
            <DialogDescription>
              {tr("dialogCustomerLine", {
                customer: dialogRow ? (pickName(dialogRow.customerNameAr, dialogRow.customerNameEn) || "—") : "—",
                total: dialogRow ? fmtMoney(dialogRow.totalAmount) : "0",
              })}
            </DialogDescription>
          </DialogHeader>

          {dialogRow && (
            <div className="space-y-4">
              {/* Raw ZATCA errors */}
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-2 text-red-700">
                  <AlertTriangle className="h-4 w-4" />
                  {tr("officialReasons")}
                </h4>
                <div className="space-y-2">
                  {parseErrors(dialogRow.zatcaErrorMessages).map((e, i) => (
                    <div key={i} className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                      <div className="text-xs font-mono text-red-600 mb-1">{e.code}</div>
                      <div className="text-sm">{e.message}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI explanation */}
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-2 text-indigo-700">
                  <Sparkles className="h-4 w-4" />
                  {tr("smartExplanation")}
                </h4>
                {aiLoading ? (
                  <div className="p-4 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 text-center text-sm text-indigo-600">
                    <Loader2 className="h-4 w-4 inline-block animate-spin ml-2" />
                    {tr("analyzing")}
                  </div>
                ) : aiData ? (
                  <div className="p-4 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 space-y-3">
                    <p className="text-sm leading-relaxed">{aiData.explanation}</p>
                    {aiData.fixes?.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-indigo-700 mb-1.5">{tr("fixSteps")}</div>
                        <ol className={`space-y-1.5 text-sm list-decimal ${isRtl ? "pr-5" : "pl-5"}`}>
                          {aiData.fixes.map((f, i) => (
                            <li key={i} className="leading-relaxed">{f}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {aiData.source === "rules" && (
                      <div className="text-xs text-muted-foreground italic">{tr("rulesSource")}</div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground p-3">{tr("noExplanation")}</div>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => { setDialogRow(null); setAiData(null); }}>
              {tr("close")}
            </Button>
            {dialogRow && (
              <Button
                onClick={() => {
                  const id = dialogRow.id;
                  setDialogRow(null);
                  navigate(`/sales/invoices/${id}`);
                }}
                className="gap-1 bg-indigo-600 hover:bg-indigo-700"
              >
                {tr("openInvoice")}
                <ChevronEnd className="h-4 w-4" />
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
