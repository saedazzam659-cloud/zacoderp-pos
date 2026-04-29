import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw, ArrowRight, AlertTriangle, Building2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// API base — same pattern other admin pages use (Modules, AuditLog…). The
// shared proxy already strips the artifact prefix, but BASE_URL keeps the
// app working under any sub-path mount.
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type DeletedCompany = {
  id: number;
  nameAr: string;
  nameEn?: string | null;
  vatNumber?: string | null;
  status?: string | null;
  deletedAt?: string | null;
};

const DELETED_KEY = ["admin", "companies", "deleted"];

export default function DeletedCompanies() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { token } = useAuth();

  // Auth is Bearer-token (localStorage-backed). Mirroring the same headers
  // pattern as the other admin pages — credentials:'include' alone would
  // 401 because the API server reads Authorization: Bearer …, not cookies.
  const jsonFetch = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 204) {
      let msg = `HTTP ${res.status}`;
      try { const body = await res.json(); msg = body?.error ?? msg; } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  };

  const { data: rows = [], isLoading, error } = useQuery<DeletedCompany[]>({
    queryKey: DELETED_KEY,
    queryFn: () => jsonFetch<DeletedCompany[]>(`${API}/api/admin/companies/deleted`),
    enabled: !!token,
  });

  const [search, setSearch] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<DeletedCompany | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DeletedCompany | null>(null);

  const restore = useMutation({
    mutationFn: (id: number) =>
      jsonFetch<{ ok: true }>(`${API}/api/admin/companies/${id}/restore`, { method: "POST" }),
    onSuccess: (_d, id) => {
      const name = rows.find(r => r.id === id)?.nameAr ?? "";
      toast({ title: "تم الإرجاع", description: `أُعيدت شركة "${name}" إلى مكانها. يجب إعادة تفعيل المستخدمين يدوياً.` });
      qc.invalidateQueries({ queryKey: DELETED_KEY });
      qc.invalidateQueries({ queryKey: ["companies"] });
      setRestoreTarget(null);
    },
    onError: (e: Error) => {
      toast({ title: "تعذّر الإرجاع", description: e.message, variant: "destructive" });
      setRestoreTarget(null);
    },
  });

  const purge = useMutation({
    mutationFn: (id: number) =>
      jsonFetch<void>(`${API}/api/admin/companies/${id}/permanent`, { method: "DELETE" }),
    onSuccess: (_d, id) => {
      const name = rows.find(r => r.id === id)?.nameAr ?? "";
      toast({
        title: "حذف نهائي",
        description: `حُذفت شركة "${name}" وكل بياناتها بشكل لا يمكن التراجع عنه.`,
      });
      qc.invalidateQueries({ queryKey: DELETED_KEY });
      qc.invalidateQueries({ queryKey: ["companies"] });
      setPurgeTarget(null);
    },
    onError: (e: Error) => {
      toast({ title: "تعذّر الحذف النهائي", description: e.message, variant: "destructive" });
      setPurgeTarget(null);
    },
  });

  const filtered = rows.filter(r => {
    if (!search.trim()) return true;
    const q = search.trim();
    return (r.nameAr ?? "").includes(q) || (r.nameEn ?? "").includes(q) || (r.vatNumber ?? "").includes(q);
  });

  const fmt = (d?: string | null) => {
    if (!d) return "—";
    try { return new Date(d).toLocaleString("ar-SA-u-nu-latn"); } catch { return d; }
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Trash2 className="h-6 w-6 text-destructive" />
            الشركات المحذوفة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            قائمة الشركات المنقولة إلى سلة المحذوفات. يمكنك إرجاع أي شركة إلى مكانها، أو حذفها نهائياً مع كل بياناتها.
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="gap-2">
          <Link href="/companies">
            <ArrowRight className="h-3.5 w-3.5" />
            عودة إلى الشركات
          </Link>
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="بحث بالاسم أو الرقم الضريبي…"
          className="pr-9"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-right px-4 py-2.5 font-medium">الشركة</th>
                <th className="text-right px-4 py-2.5 font-medium">الرقم الضريبي</th>
                <th className="text-right px-4 py-2.5 font-medium">تاريخ الحذف</th>
                <th className="text-right px-4 py-2.5 font-medium w-[260px]">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
              )}
              {!isLoading && error && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-destructive">
                  تعذّر تحميل القائمة: {(error as Error).message}
                </td></tr>
              )}
              {!isLoading && !error && filtered.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Building2 className="h-8 w-8 text-muted-foreground/40" />
                    <span>لا توجد شركات محذوفة.</span>
                  </div>
                </td></tr>
              )}
              {!isLoading && !error && filtered.map(c => (
                <tr key={c.id} className="border-t hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.nameAr}</div>
                    {c.nameEn && <div className="text-xs text-muted-foreground">{c.nameEn}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{c.vatNumber ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(c.deletedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-8"
                        onClick={() => setRestoreTarget(c)}
                        disabled={restore.isPending || purge.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        إرجاع إلى مكانها
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 h-8 text-destructive hover:bg-destructive/10"
                        onClick={() => setPurgeTarget(c)}
                        disabled={restore.isPending || purge.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        حذف نهائي
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
            العدد: <strong>{filtered.length}</strong>
          </div>
        )}
      </div>

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreTarget} onOpenChange={open => !open && setRestoreTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              إرجاع الشركة إلى مكانها
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right space-y-1">
              <span>سيتم إرجاع شركة </span>
              <strong className="text-foreground">"{restoreTarget?.nameAr}"</strong>
              <span> إلى قائمة الشركات النشطة.</span>
              <br />
              <span className="text-muted-foreground">
                ملاحظة: حسابات المستخدمين ستبقى مُعطّلة ويلزم تفعيلها يدوياً من إدارة المستخدمين.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreTarget && restore.mutate(restoreTarget.id)}
              disabled={restore.isPending}
              className="gap-2"
            >
              <RotateCcw className="h-4 w-4" />
              {restore.isPending ? "جارٍ الإرجاع…" : "نعم، أرجِع الشركة"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Permanent-delete confirmation */}
      <AlertDialog open={!!purgeTarget} onOpenChange={open => !open && setPurgeTarget(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              حذف الشركة نهائياً
            </AlertDialogTitle>
            <AlertDialogDescription className="text-right space-y-1">
              <span>سيتم حذف شركة </span>
              <strong className="text-foreground">"{purgeTarget?.nameAr}"</strong>
              <span> وكل بياناتها (الفواتير، العملاء، الموردين، المستخدمين، الاشتراكات…) بشكل نهائي.</span>
              <br />
              <span className="text-destructive font-medium">هذا الإجراء لا يمكن التراجع عنه.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => purgeTarget && purge.mutate(purgeTarget.id)}
              disabled={purge.isPending}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {purge.isPending ? "جارٍ الحذف…" : "نعم، احذف نهائياً"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
