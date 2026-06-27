// SAP-style sequence-movement monitor (متابعة حركات المسلسل).
// Admins-only. Lists every number issued across the company's sequences with
// filters by module / transaction type / date / search, and surfaces whether
// the linked document still EXISTS (live) or was deleted. Read-only.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import {
  sequencesApi,
  type SequenceActivityRow,
  type SequenceRow,
} from "@/lib/sequencesApi";
import {
  refTableLabel,
  refDocPath,
  SEQUENCE_MODULES,
  txTypesForModule,
} from "@/lib/sequenceLabels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SmartDateInput } from "@/components/ui/smart-date-input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Activity, ArrowRight, Search, ExternalLink, CheckCircle2, XCircle,
  ChevronRight, ChevronLeft, Hash, FileStack, Loader2,
} from "lucide-react";

const PAGE_SIZE = 25;
const ALL = "__all__";

export default function SequenceMonitor() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith("ar");

  // Filters
  const [moduleKey, setModuleKey] = useState<string>(ALL);
  const [txType, setTxType] = useState<string>(ALL);
  const [sequenceId, setSequenceId] = useState<string>(ALL);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [includeReset, setIncludeReset] = useState(false);
  const [page, setPage] = useState(0);

  // Sequences list — powers the "specific sequence" picker and code labels.
  const { data: sequences = [] } = useQuery<SequenceRow[]>({
    queryKey: ["sequences"],
    queryFn: () => sequencesApi.list(),
  });

  // The transaction-type list shown in the secondary dropdown depends on the
  // selected module (so picking "المبيعات" narrows the types to sales only).
  const moduleTxTypes = useMemo(
    () => (moduleKey === ALL ? [] : txTypesForModule(moduleKey)),
    [moduleKey],
  );

  // Resolve which txTypes actually go to the server: a specific txType wins;
  // otherwise the whole module's set; otherwise none (all).
  const effectiveTxTypes = useMemo(() => {
    if (txType !== ALL) return [txType];
    if (moduleKey !== ALL) return moduleTxTypes;
    return undefined;
  }, [txType, moduleKey, moduleTxTypes]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      "sequence-activity",
      effectiveTxTypes?.join(",") ?? "",
      sequenceId,
      dateFrom,
      dateTo,
      q,
      includeReset,
      page,
    ],
    queryFn: () =>
      sequencesApi.activity({
        txTypes: effectiveTxTypes,
        sequenceId: sequenceId === ALL ? null : Number(sequenceId),
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        q: q || undefined,
        includeReset,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: (prev) => prev,
  });

  const rows: SequenceActivityRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Header stat cards (current page scope is fine for live/deleted split since
  // the backend returns the live flag per row; "total" is the full filtered set).
  const liveOnPage = rows.filter((r) => r.live === true).length;
  const deletedOnPage = rows.filter((r) => r.live === false).length;

  function resetFilters() {
    setModuleKey(ALL);
    setTxType(ALL);
    setSequenceId(ALL);
    setDateFrom("");
    setDateTo("");
    setQ("");
    setQInput("");
    setIncludeReset(false);
    setPage(0);
  }

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(isAr ? "ar-EG" : "en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  };

  // Arabic label for a transaction type, falling back to the i18n key the
  // Sequences screen uses (sequences.tx.<key>), then the raw key.
  const txLabel = (key: string) => {
    const tk = `sequences.tx.${key}`;
    const tr = t(tk);
    return tr === tk ? key : tr;
  };

  return (
    <div className="p-4 md:p-6 space-y-5" dir={isAr ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 p-2.5 text-white shadow-sm">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t("nav.sequenceMonitor")}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              متابعة كل الأرقام الصادرة عبر المسلسلات مع المستند المرتبط وحالته (قائم/محذوف).
            </p>
          </div>
        </div>
        <Link href="/settings/sequences">
          <Button variant="outline" data-testid="button-back-sequences">
            {isAr ? <ArrowRight className="w-4 h-4 me-1" /> : null}
            إدارة المسلسلات
          </Button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="border-indigo-100">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600"><Hash className="w-5 h-5" /></div>
            <div>
              <div className="text-2xl font-bold tabular-nums" data-testid="stat-total">{total.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">إجمالي الحركات (بالفلاتر الحالية)</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-emerald-100">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600"><CheckCircle2 className="w-5 h-5" /></div>
            <div>
              <div className="text-2xl font-bold tabular-nums" data-testid="stat-live">{liveOnPage}</div>
              <div className="text-xs text-muted-foreground">مستندات قائمة (بالصفحة الحالية)</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-100">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-red-50 p-2 text-red-600"><XCircle className="w-5 h-5" /></div>
            <div>
              <div className="text-2xl font-bold tabular-nums" data-testid="stat-deleted">{deletedOnPage}</div>
              <div className="text-xs text-muted-foreground">مستندات محذوفة (بالصفحة الحالية)</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">الوحدة (Module)</Label>
              <Select
                value={moduleKey}
                onValueChange={(v) => { setModuleKey(v); setTxType(ALL); setPage(0); }}
              >
                <SelectTrigger data-testid="select-module"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>كل الوحدات</SelectItem>
                  {SEQUENCE_MODULES.map((m) => (
                    <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">نوع الحركة</Label>
              <Select
                value={txType}
                onValueChange={(v) => { setTxType(v); setPage(0); }}
                disabled={moduleKey === ALL}
              >
                <SelectTrigger data-testid="select-txtype">
                  <SelectValue placeholder={moduleKey === ALL ? "اختر وحدة أولاً" : "كل الأنواع"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>كل الأنواع</SelectItem>
                  {moduleTxTypes.map((tx) => (
                    <SelectItem key={tx} value={tx}>{txLabel(tx)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">المسلسل</Label>
              <Select
                value={sequenceId}
                onValueChange={(v) => { setSequenceId(v); setPage(0); }}
              >
                <SelectTrigger data-testid="select-sequence"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>كل المسلسلات</SelectItem>
                  {sequences.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.code} — {isAr ? s.nameAr : (s.nameEn || s.nameAr)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">بحث (رقم / مرجع)</Label>
              <form
                onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); setPage(0); }}
                className="flex gap-1"
              >
                <Input
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder="مثال: INV-000123"
                  data-testid="input-search"
                />
                <Button type="submit" variant="secondary" size="icon" data-testid="button-search">
                  <Search className="w-4 h-4" />
                </Button>
              </form>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">من تاريخ</Label>
              <SmartDateInput
                value={dateFrom}
                onChange={(v) => { setDateFrom(v); setPage(0); }}
                data-testid="input-date-from"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">إلى تاريخ</Label>
              <SmartDateInput
                value={dateTo}
                onChange={(v) => { setDateTo(v); setPage(0); }}
                data-testid="input-date-to"
              />
            </div>

            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none" data-testid="label-include-reset">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={includeReset}
                  onChange={(e) => { setIncludeReset(e.target.checked); setPage(0); }}
                  data-testid="checkbox-include-reset"
                />
                إظهار حركات التصفير
              </label>
            </div>
            <div className="flex items-end">
              <Button variant="ghost" onClick={resetFilters} data-testid="button-reset-filters">
                مسح الفلاتر
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr className="text-start">
                  <th className="px-4 py-3 text-start font-medium">الرقم الصادر</th>
                  <th className="px-4 py-3 text-start font-medium">المسلسل</th>
                  <th className="px-4 py-3 text-start font-medium">نوع الحركة</th>
                  <th className="px-4 py-3 text-start font-medium">المستند / الشاشة</th>
                  <th className="px-4 py-3 text-start font-medium">الحالة</th>
                  <th className="px-4 py-3 text-start font-medium">التاريخ</th>
                  <th className="px-4 py-3 text-start font-medium">المستخدم</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <FileStack className="w-10 h-10 mx-auto mb-2 opacity-40" />
                      لا توجد حركات مطابقة للفلاتر الحالية.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const isReset = r.transactionType === "__reset__";
                    const docPath = refDocPath(r.refTable, r.refId);
                    return (
                      <tr
                        key={r.id}
                        className="border-t hover:bg-muted/30 transition-colors"
                        data-testid={`row-activity-${r.id}`}
                      >
                        <td className="px-4 py-2.5 font-mono font-semibold tabular-nums">
                          {r.generatedNumber}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{r.sequenceCode ?? "—"}</span>
                          {r.sequenceName && (
                            <span className="text-muted-foreground"> · {r.sequenceName}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isReset ? (
                            <Badge variant="outline" className="border-amber-300 text-amber-700">تصفير</Badge>
                          ) : (
                            <Badge variant="secondary">{txLabel(r.transactionType)}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.refTable ? (
                            docPath && r.live ? (
                              <Link href={docPath}>
                                <span className="inline-flex items-center gap-1 text-indigo-600 hover:underline cursor-pointer">
                                  {refTableLabel(r.refTable)}
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </span>
                              </Link>
                            ) : (
                              <span className="text-foreground">{refTableLabel(r.refTable)}</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.live === null ? (
                            <Badge variant="outline" className="text-muted-foreground">—</Badge>
                          ) : r.live ? (
                            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> قائم
                            </Badge>
                          ) : (
                            <Badge className="bg-red-100 text-red-800 hover:bg-red-100 gap-1">
                              <XCircle className="w-3.5 h-3.5" /> محذوف
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                          {fmtDate(r.createdAt)}
                        </td>
                        <td className="px-4 py-2.5">{r.userName ?? "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3 flex-wrap">
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              {isFetching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {total > 0 ? (
                <span>
                  عرض {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} من {total.toLocaleString()}
                </span>
              ) : (
                <span>لا نتائج</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                data-testid="button-prev-page"
              >
                {isAr ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                السابق
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {page + 1} / {totalPages}
              </span>
              <Button
                variant="outline" size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                data-testid="button-next-page"
              >
                التالي
                {isAr ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
