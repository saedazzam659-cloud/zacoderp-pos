import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useFormatters } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { trialBalancesApi, type TrialBalance } from "@/lib/trialBalancesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Search, Pencil, Trash2, Eye, Wrench, CheckCircle2, AlertCircle, Clock, FileSpreadsheet } from "lucide-react";

const STATUS_MAP: Record<string, { labelKey: string; cls: string; Icon: any }> = {
  draft:     { labelKey: "trialBalanceMaintenance.statusDraft",    cls: "bg-yellow-50 text-yellow-700 border-yellow-200", Icon: Clock },
  in_review: { labelKey: "trialBalanceMaintenance.statusInReview", cls: "bg-blue-50 text-blue-700 border-blue-200", Icon: AlertCircle },
  approved:  { labelKey: "trialBalanceMaintenance.statusApproved", cls: "bg-green-50 text-green-700 border-green-200", Icon: CheckCircle2 },
};

const TYPE_MAP: Record<string, string> = {
  opening:       "trialBalanceMaintenance.typeOpening",
  before_review: "trialBalanceMaintenance.typeBeforeReview",
  after_review:  "trialBalanceMaintenance.typeAfterReview",
  closing:       "trialBalanceMaintenance.typeClosing",
};

export default function TrialBalances() {
  const { user } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt } = useFormatters();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const [search, setSearch]       = useState("");
  const [filterStatus, setStatus] = useState<string>("all");
  const [filterType, setType]     = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId]   = useState<number | null>(null);

  const [newFY, setNewFY] = useState<string>(String(new Date().getFullYear()));
  const [newStart, setNewStart] = useState<string>(`${new Date().getFullYear()}-01-01`);
  const [newEnd, setNewEnd]     = useState<string>(`${new Date().getFullYear()}-12-31`);
  const [newType, setNewType]   = useState<string>("before_review");
  const [newNotes, setNewNotes] = useState<string>("");

  const { data: rows = [], isLoading } = useQuery<TrialBalance[]>({
    queryKey: ["trial-balances", cid],
    queryFn:  () => trialBalancesApi.list(),
    enabled:  !!user,
  });

  const createMut = useMutation({
    mutationFn: () => trialBalancesApi.create({
      fiscalYear:  newFY,
      periodStart: newStart,
      periodEnd:   newEnd,
      balanceType: newType as any,
      notes:       newNotes || null,
    }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["trial-balances", cid] });
      setCreateOpen(false);
      setNewNotes("");
      toast({ title: t("trialBalanceMaintenance.createdToast") });
      navigate(`/accounting/maintenance/${row.id}`);
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => trialBalancesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trial-balances", cid] });
      setDeleteId(null);
      toast({ title: t("trialBalanceMaintenance.deletedToast") });
    },
    onError: (e: any) => toast({ title: t("common.error"), description: String(e?.message || e), variant: "destructive" }),
  });

  const filtered = rows.filter(r =>
    (filterStatus === "all" || r.status === filterStatus) &&
    (filterType   === "all" || r.balanceType === filterType) &&
    (!search ||
      r.fiscalYear.includes(search) ||
      r.periodStart.includes(search) ||
      r.periodEnd.includes(search) ||
      (r.notes ?? "").includes(search))
  );

  return (
    <div className="space-y-4 p-4" data-testid="trial-balances-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wrench className="h-6 w-6 text-primary" />
            {t("trialBalanceMaintenance.pageTitle")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("trialBalanceMaintenance.pageSubtitle")}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="btn-new-trial-balance">
              <Plus className="h-4 w-4 me-2" />
              {t("trialBalanceMaintenance.newButton")}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("trialBalanceMaintenance.newDialogTitle")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-sm">{t("trialBalanceMaintenance.fiscalYear")}</label>
                <Input data-testid="input-fiscal-year" value={newFY} onChange={e => setNewFY(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm">{t("trialBalanceMaintenance.periodStart")}</label>
                  <Input data-testid="input-period-start" type="date" value={newStart} onChange={e => setNewStart(e.target.value)} />
                </div>
                <div>
                  <label className="text-sm">{t("trialBalanceMaintenance.periodEnd")}</label>
                  <Input data-testid="input-period-end" type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="text-sm">{t("trialBalanceMaintenance.balanceType")}</label>
                <Select value={newType} onValueChange={setNewType}>
                  <SelectTrigger data-testid="select-balance-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_MAP).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{t(v)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm">{t("trialBalanceMaintenance.notes")}</label>
                <Input data-testid="input-notes" value={newNotes} onChange={e => setNewNotes(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button data-testid="btn-create-confirm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
                {createMut.isPending ? t("common.saving") : t("common.create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            {t("trialBalanceMaintenance.listTitle")}
            <Badge variant="secondary">{filtered.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute top-2.5 start-2 h-4 w-4 text-muted-foreground" />
              <Input
                data-testid="input-search"
                className="ps-8"
                placeholder={t("trialBalanceMaintenance.searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Select value={filterStatus} onValueChange={setStatus}>
              <SelectTrigger className="w-[160px]" data-testid="filter-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("trialBalanceMaintenance.allStatuses")}</SelectItem>
                {Object.entries(STATUS_MAP).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{t(v.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterType} onValueChange={setType}>
              <SelectTrigger className="w-[160px]" data-testid="filter-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("trialBalanceMaintenance.allTypes")}</SelectItem>
                {Object.entries(TYPE_MAP).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{t(v)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto border rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-start p-2">#</th>
                  <th className="text-start p-2">{t("trialBalanceMaintenance.fiscalYear")}</th>
                  <th className="text-start p-2">{t("trialBalanceMaintenance.period")}</th>
                  <th className="text-start p-2">{t("trialBalanceMaintenance.balanceType")}</th>
                  <th className="text-start p-2">{t("trialBalanceMaintenance.status")}</th>
                  <th className="text-end p-2">{t("trialBalanceMaintenance.totalDebit")}</th>
                  <th className="text-end p-2">{t("trialBalanceMaintenance.totalCredit")}</th>
                  <th className="text-end p-2">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">{t("common.loading")}</td></tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">{t("trialBalanceMaintenance.empty")}</td></tr>
                )}
                {filtered.map(r => {
                  const st = STATUS_MAP[r.status] ?? STATUS_MAP.draft;
                  const StIcon = st.Icon;
                  const balanced = Math.abs(Number(r.totalDebit) - Number(r.totalCredit)) < 0.01;
                  return (
                    <tr key={r.id} className="border-t hover:bg-muted/30" data-testid={`row-tb-${r.id}`}>
                      <td className="p-2 font-mono text-xs">#{r.id}</td>
                      <td className="p-2">{r.fiscalYear}</td>
                      <td className="p-2">{r.periodStart} ← {r.periodEnd}</td>
                      <td className="p-2">{t(TYPE_MAP[r.balanceType] ?? "trialBalanceMaintenance.typeBeforeReview")}</td>
                      <td className="p-2">
                        <Badge className={st.cls}>
                          <StIcon className="h-3 w-3 me-1" />
                          {t(st.labelKey)}
                        </Badge>
                      </td>
                      <td className="p-2 text-end font-mono">{fmt(Number(r.totalDebit))}</td>
                      <td className={`p-2 text-end font-mono ${balanced ? "" : "text-red-600 font-bold"}`}>
                        {fmt(Number(r.totalCredit))}
                      </td>
                      <td className="p-2 text-end">
                        <div className="flex gap-1 justify-end">
                          <Button size="icon" variant="ghost" onClick={() => navigate(`/accounting/maintenance/${r.id}`)}
                            data-testid={`btn-view-${r.id}`}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          {r.status !== "approved" && (
                            <Button size="icon" variant="ghost" onClick={() => navigate(`/accounting/maintenance/${r.id}`)}
                              data-testid={`btn-edit-${r.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {r.status !== "approved" && (
                            <Button size="icon" variant="ghost" onClick={() => setDeleteId(r.id)}
                              data-testid={`btn-delete-${r.id}`}>
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteId !== null} onOpenChange={o => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("trialBalanceMaintenance.confirmDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("trialBalanceMaintenance.confirmDeleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteId && deleteMut.mutate(deleteId)}>
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
