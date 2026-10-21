import { useState } from "react";
import { Link, Redirect } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi, type StockLedgerPage } from "@/lib/inventoryApi";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { TablePagination, type PageSize } from "@/components/TablePagination";
import { useFmt } from "@/hooks/use-fmt";
import { Search, Factory, RotateCcw } from "lucide-react";
import { companyAllowsAnyModule } from "@/lib/companyModuleGate";

const today = new Date().toISOString().slice(0, 10);
const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  .toISOString().slice(0, 10);
const PAGE_SIZE: PageSize = 25;
const EMPTY_PAGE: StockLedgerPage = {
  rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, pageCount: 1,
  summary: { opening: 0, totalIn: 0, totalOut: 0, final: 0 },
};

type Filters = { from: string; to: string; itemId: string; warehouseId: string; orderSearch: string };

export default function ProductionIssues() {
  const { user } = useAuth();
  if (!user) return null;
  if (!companyAllowsAnyModule(user, ["production", "simple_manufacturing"])) {
    return <Redirect to="/inventory" />;
  }
  return <ProductionIssuesReport />;
}

function ProductionIssuesReport() {
  const { user } = useAuth();
  const { fmt, fmtQty } = useFmt();
  const companyId = user?.role === "superadmin" ? undefined : user?.company?.id;
  const initial: Filters = { from: monthStart, to: today, itemId: "", warehouseId: "", orderSearch: "" };
  const [filters, setFilters] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [page, setPage] = useState(1);
  const itemsQuery = useQuery({
    queryKey: ["items", companyId],
    queryFn: () => inventoryApi.getItems(companyId),
  });
  const warehousesQuery = useQuery({
    queryKey: ["warehouses", companyId],
    queryFn: () => inventoryApi.getWarehouses(companyId),
  });

  const ledgerQuery = useQuery({
    queryKey: ["manufacturing-issues", companyId, applied, page],
    queryFn: () => {
      const params: Record<string, string> = {
        page: String(page),
        pageSize: String(PAGE_SIZE),
        txType: "production_issue",
        manufacturingIssuesOnly: "1",
      };
      if (companyId) params.companyId = String(companyId);
      if (applied.from) params.from = applied.from;
      if (applied.to) params.to = applied.to;
      if (applied.itemId) params.itemId = applied.itemId;
      if (applied.warehouseId) params.warehouseId = applied.warehouseId;
      if (applied.orderSearch.trim()) params.productionOrderSearch = applied.orderSearch.trim();
      return inventoryApi.getLedgerPage(params);
    },
  });
  const data = ledgerQuery.data ?? EMPTY_PAGE;
  const items = (itemsQuery.data ?? []) as any[];
  const warehouses = (warehousesQuery.data ?? []) as any[];
  const itemOptions = items.map((item) => ({
    value: String(item.id),
    code: item.code,
    label: item.nameAr ?? item.nameEn ?? item.code,
    labelEn: item.nameEn ?? undefined,
  }));
  const warehouseOptions = warehouses.map((warehouse) => ({
    value: String(warehouse.id),
    label: warehouse.nameAr ?? warehouse.nameEn ?? `#${warehouse.id}`,
    labelEn: warehouse.nameEn ?? undefined,
  }));
  const applyFilters = () => {
    setPage(1);
    setApplied({ ...filters, orderSearch: filters.orderSearch.trim() });
  };
  const orderPath = (id: number) => {
    const userPermissions = (user as any)?.permissions;
    const productionAllowed = companyAllowsAnyModule(user, ["production"]);
    const canOpenProduction = productionAllowed &&
      (user?.role === "admin" || userPermissions?.production?.view === true);
    const simpleAllowed = companyAllowsAnyModule(user, ["simple_manufacturing"]);
    const canOpenSimple = simpleAllowed &&
      (user?.role === "admin" || userPermissions?.simple_manufacturing?.view === true);
    if (canOpenProduction) return `/production/orders/${id}`;
    if (canOpenSimple) return `/simple-manufacturing/orders/${id}`;
    return null;
  };
  const resetFilters = () => {
    setFilters(initial);
    setApplied(initial);
    setPage(1);
  };

  return (
    <div className="p-4 md:p-6 space-y-5" dir="rtl">
      <header className="flex items-center gap-3">
        <Factory className="h-6 w-6 text-orange-600" />
        <div>
          <h1 className="text-xl font-bold">إذن صرف خامات التصنيع</h1>
          <p className="text-sm text-muted-foreground">
            عرض للقراءة فقط لحركات صرف الخامات المسجلة على أوامر الإنتاج.
          </p>
        </div>
      </header>

      <Card className="p-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end">
          <div className="space-y-1">
            <Label htmlFor="issue-from">من تاريخ</Label>
            <Input id="issue-from" type="date" value={filters.from}
              onChange={(event) => setFilters((old) => ({ ...old, from: event.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="issue-to">إلى تاريخ</Label>
            <Input id="issue-to" type="date" value={filters.to}
              onChange={(event) => setFilters((old) => ({ ...old, to: event.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>المادة الخام</Label>
            <SearchCombobox items={itemOptions} value={filters.itemId}
              onValueChange={(itemId) => setFilters((old) => ({ ...old, itemId }))}
              placeholder="كل المواد" searchPlaceholder="ابحث باسم المادة أو كودها"
              clearable testId="production-issue-item" />
          </div>
          <div className="space-y-1">
            <Label>المخزن</Label>
            <SearchCombobox items={warehouseOptions} value={filters.warehouseId}
              onValueChange={(warehouseId) => setFilters((old) => ({ ...old, warehouseId }))}
              placeholder="كل المخازن" searchPlaceholder="ابحث عن مخزن"
              clearable testId="production-issue-warehouse" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="production-order-search">رقم أمر الإنتاج</Label>
            <Input id="production-order-search" value={filters.orderSearch}
              onChange={(event) => setFilters((old) => ({ ...old, orderSearch: event.target.value }))}
              placeholder="اكتب رقم الأمر" data-testid="production-issue-order-search" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={applyFilters} disabled={ledgerQuery.isFetching} data-testid="production-issue-apply">
            <Search className="h-4 w-4 me-2" /> عرض الحركات
          </Button>
          <Button variant="outline" onClick={resetFilters} data-testid="production-issue-reset">
            <RotateCcw className="h-4 w-4 me-2" /> إعادة ضبط
          </Button>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">إجمالي الكمية المصروفة</div>
          <div className="mt-1 text-xl font-bold" data-testid="production-issue-total-qty">
            {fmtQty(data.summary.totalOut)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">إجمالي تكلفة الصرف</div>
          <div className="mt-1 text-xl font-bold" data-testid="production-issue-total-cost">
            {fmt(data.rows.reduce((sum, row) => sum + Math.abs(Number(row.totalCost) || 0), 0))}
          </div>
          <div className="text-xs text-muted-foreground">تكلفة السطور الظاهرة في الصفحة الحالية</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">عدد حركات الصرف</div>
          <div className="mt-1 text-xl font-bold">{data.total}</div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="font-semibold">حركات صرف المواد الخام</h2>
          <p className="text-xs text-muted-foreground mt-1">
            هذه الشاشة لا تنشئ أو تعدّل حركات مخزون. أي عكس أو إلغاء يظهر كحركة منفصلة في دفتر حركة المخزون.
          </p>
        </div>
        {ledgerQuery.isError ? (
          <div className="p-6 text-sm text-destructive">
            تعذر تحميل حركات الصرف: {(ledgerQuery.error as Error).message}
          </div>
        ) : ledgerQuery.isLoading ? (
          <div className="p-4 space-y-3"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : data.rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">لا توجد حركات صرف مطابقة للفلاتر.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-3 text-start">التاريخ</th>
                  <th className="p-3 text-start">أمر الإنتاج</th>
                  <th className="p-3 text-start">المادة الخام</th>
                  <th className="p-3 text-start">المخزن</th>
                  <th className="p-3 text-start">التشغيلة / الانتهاء</th>
                  <th className="p-3 text-end">الكمية المصروفة</th>
                  <th className="p-3 text-end">التكلفة</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className="border-t" data-testid={`production-issue-row-${row.id}`}>
                    <td className="p-3 whitespace-nowrap">{String(row.txDate).slice(0, 10)}</td>
                    <td className="p-3">
                      {row.refId && orderPath(row.refId) ? (
                        <Link href={orderPath(row.refId)!}>
                          <a className="text-primary hover:underline">{row.documentNumber ?? `#${row.refId}`}</a>
                        </Link>
                      ) : row.documentNumber ?? (row.refId ? `#${row.refId}` : "—")}
                    </td>
                    <td className="p-3">
                      <div>{row.item?.nameAr ?? row.item?.nameEn ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{row.item?.code ?? ""}</div>
                    </td>
                    <td className="p-3">{row.warehouse?.nameAr ?? row.warehouse?.nameEn ?? "—"}</td>
                    <td className="p-3">
                      <div>{row.batchNumber ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{row.expiryDate ?? ""}</div>
                    </td>
                    <td className="p-3 text-end font-medium">{fmtQty(Math.abs(Number(row.qty) || 0))}</td>
                    <td className="p-3 text-end">{fmt(Math.abs(Number(row.totalCost) || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="p-3 border-t">
          <TablePagination page={page} pageSize={PAGE_SIZE} pageCount={data.pageCount} total={data.total}
            onPageChange={setPage} onPageSizeChange={() => undefined} pageSizeOptions={[PAGE_SIZE]} itemLabel="حركة صرف" />
        </div>
      </Card>
    </div>
  );
}
