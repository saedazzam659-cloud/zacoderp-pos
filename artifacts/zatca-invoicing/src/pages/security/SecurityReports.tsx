import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Users, Factory, Warehouse, Building2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { securityReportsApi } from "@/lib/securityAiApi";

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleString("ar-SA");
}

export default function SecurityReports() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);

  const hrQ        = useQuery({ queryKey: ["sec-reports", "hr", days],        queryFn: () => securityReportsApi.hrCompliance(days) });
  const prodQ      = useQuery({ queryKey: ["sec-reports", "prod", days],      queryFn: () => securityReportsApi.productionDowntime(days) });
  const whQ        = useQuery({ queryKey: ["sec-reports", "wh", days],        queryFn: () => securityReportsApi.warehouseNight(days) });
  const branchQ    = useQuery({ queryKey: ["sec-reports", "branch", days],    queryFn: () => securityReportsApi.branchComparison(days) });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-rose-600" />
            {t("security.reports.title")}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t("security.ai.last7")}</SelectItem>
                <SelectItem value="30">{t("security.ai.last30")}</SelectItem>
                <SelectItem value="90">{t("security.ai.last90")}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => { hrQ.refetch(); prodQ.refetch(); whQ.refetch(); branchQ.refetch(); }}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="hr">
            <TabsList>
              <TabsTrigger value="hr"><Users className="w-4 h-4 me-1" />{t("security.reports.hr")}</TabsTrigger>
              <TabsTrigger value="prod"><Factory className="w-4 h-4 me-1" />{t("security.reports.production")}</TabsTrigger>
              <TabsTrigger value="wh"><Warehouse className="w-4 h-4 me-1" />{t("security.reports.warehouse")}</TabsTrigger>
              <TabsTrigger value="branch"><Building2 className="w-4 h-4 me-1" />{t("security.reports.branches")}</TabsTrigger>
            </TabsList>

            <TabsContent value="hr">
              <ReportTable
                head={[t("security.reports.col.employee"), t("security.reports.col.total"), t("security.reports.col.open"), t("security.reports.col.critical"), t("security.reports.col.high"), t("security.reports.col.last")]}
                rows={(hrQ.data?.items ?? []).map(r => [
                  `موظف #${r.employeeId}`,
                  r.total,
                  r.open,
                  r.critical,
                  r.high,
                  fmtDate(r.lastAt),
                ])}
              />
            </TabsContent>
            <TabsContent value="prod">
              <ReportTable
                head={[t("security.reports.col.line"), t("security.reports.col.total"), t("security.reports.col.open"), t("security.reports.col.stops"), t("security.reports.col.last")]}
                rows={(prodQ.data?.items ?? []).map(r => [
                  `خط #${r.productionLineId}`,
                  r.total, r.open, r.stops, fmtDate(r.lastAt),
                ])}
              />
            </TabsContent>
            <TabsContent value="wh">
              <ReportTable
                head={[t("security.reports.col.warehouse"), t("security.reports.col.total"), t("security.reports.col.critical"), t("security.reports.col.last")]}
                rows={(whQ.data?.items ?? []).map(r => [
                  `مخزن #${r.warehouseId}`, r.total, r.critical, fmtDate(r.lastAt),
                ])}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("security.reports.warehouseNote", { from: whQ.data?.startHour ?? 22, to: whQ.data?.endHour ?? 6 })}
              </p>
            </TabsContent>
            <TabsContent value="branch">
              <ReportTable
                head={[t("security.reports.col.branch"), t("security.reports.col.cameras"), t("security.reports.col.total"), t("security.reports.col.open"), t("security.reports.col.critical")]}
                rows={(branchQ.data?.items ?? []).map(r => [
                  r.branchId == null ? "—" : `فرع #${r.branchId}`,
                  r.cameras, r.total, r.open, r.critical,
                ])}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function ReportTable({ head, rows }: { head: string[]; rows: Array<Array<any>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground">
            {head.map((h, i) => <th key={i} className="p-2 text-start">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={head.length} className="p-4 text-center text-muted-foreground">—</td></tr>
          )}
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t">
              {r.map((c, ci) => (
                <td key={ci} className="p-2">
                  {typeof c === "number" ? <Badge variant="outline" className="font-mono">{c}</Badge> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
