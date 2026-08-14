import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, todayISO } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Card, ErrorBox, Field } from '@/components/ui';

/**
 * Financial reports — same api-server endpoints the web uses:
 *   trial-balance    GET /api/accounting-reports/trial-balance?fromDate&toDate
 *   balance-sheet    GET /api/accounting-reports/balance-sheet?asOfDate
 *   income-statement GET /api/accounting-reports/income-statement?fromDate&toDate
 *   vat              GET /api/reports/vat-declaration?from&to
 */
const TITLES: Record<string, string> = {
  'trial-balance': 'ميزان المراجعة',
  'balance-sheet': 'قائمة المركز المالي',
  'income-statement': 'قائمة الدخل',
  vat: 'الإقرار الضريبي',
};

function yearStartISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

const num = (v: any) => parseFloat(String(v ?? 0)) || 0;

export default function ReportScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const router = useRouter();
  const { companyId, can } = useAuth();
  const allowed = kind === 'vat' ? can('vat_declaration', 'view') : can('accounting_reports', 'view');
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [fromDate, setFromDate] = useState(yearStartISO());
  const [toDate, setToDate] = useState(todayISO());
  const isAsOf = kind === 'balance-sheet';

  const url = useMemo(() => {
    const cid = `companyId=${companyId}`;
    switch (kind) {
      case 'trial-balance':
        return `/api/accounting-reports/trial-balance?${cid}&fromDate=${fromDate}&toDate=${toDate}`;
      case 'balance-sheet':
        return `/api/accounting-reports/balance-sheet?${cid}&asOfDate=${toDate}`;
      case 'income-statement':
        return `/api/accounting-reports/income-statement?${cid}&fromDate=${fromDate}&toDate=${toDate}`;
      case 'vat':
        return `/api/reports/vat-declaration?${cid}&from=${fromDate}&to=${toDate}`;
      default:
        return null;
    }
  }, [kind, companyId, fromDate, toDate]);

  const q = useQuery({
    queryKey: ['report', kind, companyId, fromDate, toDate],
    queryFn: () => api<any>(url!),
    enabled: !!companyId && !!url && allowed,
  });

  const Row = ({ label, value, bold, indent }: { label: string; value: string; bold?: boolean; indent?: boolean }) => (
    <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', paddingVertical: 6, paddingRight: indent ? 12 : 0, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={{ flex: 1, textAlign: 'right', fontSize: 13, color: bold ? c.foreground : c.mutedForeground, fontFamily: bold ? 'Inter_700Bold' : 'Inter_400Regular' }}>{label}</Text>
      <Text style={{ fontSize: 13, color: bold ? c.primary : c.foreground, fontFamily: bold ? 'Inter_700Bold' : 'Inter_500Medium' }}>{value}</Text>
    </View>
  );

  const Section = ({ title, rows, total, totalLabel }: { title: string; rows: any[]; total?: number; totalLabel?: string }) => (
    <Card style={{ gap: 2 }}>
      <Text style={{ fontSize: 14, fontFamily: 'Inter_700Bold', textAlign: 'right', color: c.foreground, marginBottom: 6 }}>{title}</Text>
      {rows.map((r: any, i: number) => (
        <Row key={i} indent label={`${r.code ?? r.accountCode ?? ''} ${r.nameAr ?? r.name ?? r.accountName ?? ''}`} value={money(num(r.balance ?? r.amount ?? r.total))} />
      ))}
      {!rows.length ? <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 12 }}>لا توجد بيانات</Text> : null}
      {total !== undefined ? <Row bold label={totalLabel ?? 'الإجمالي'} value={money(total)} /> : null}
    </Card>
  );

  const body = () => {
    if (!allowed) {
      return (
        <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا تملك صلاحية عرض هذا التقرير.</Text></Card>
      );
    }
    if (q.isLoading) return <ActivityIndicator color={c.primary} size="large" style={{ marginTop: 40 }} />;
    if (q.isError) return <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل التقرير'} onRetry={() => q.refetch()} />;
    const d: any = q.data;
    if (!d) return null;

    if (kind === 'trial-balance') {
      const rows = Array.isArray(d) ? d : [];
      const td = rows.reduce((s: number, r: any) => s + num(r.totalDebit), 0);
      const tc = rows.reduce((s: number, r: any) => s + num(r.totalCredit), 0);
      return (
        <Card style={{ gap: 2 }}>
          {rows.filter((r: any) => num(r.totalDebit) !== 0 || num(r.totalCredit) !== 0).map((r: any, i: number) => (
            <View key={i} style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 6, gap: 2 }}>
              <Text style={{ textAlign: 'right', fontSize: 13, color: c.foreground, fontFamily: 'Inter_500Medium' }}>{r.code ?? ''} {r.nameAr ?? r.name ?? ''}</Text>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, color: c.mutedForeground }}>مدين {money(num(r.totalDebit))}</Text>
                <Text style={{ fontSize: 12, color: c.mutedForeground }}>دائن {money(num(r.totalCredit))}</Text>
              </View>
            </View>
          ))}
          <Row bold label="إجمالي المدين" value={money(td)} />
          <Row bold label="إجمالي الدائن" value={money(tc)} />
        </Card>
      );
    }

    if (kind === 'balance-sheet') {
      // الرصيد الدائن يأتي سالباً من الخادم — نعرض القيم المطلقة كما في تقرير الويب
      const absRows = (rows: any[]) => rows.map((r) => ({ ...r, balance: Math.abs(num(r.balance ?? r.amount ?? r.total)) }));
      return (
        <View style={{ gap: 12 }}>
          <Section title="الأصول" rows={absRows(Array.isArray(d.assets) ? d.assets : [])} total={Math.abs(num(d.totalAssets))} totalLabel="إجمالي الأصول" />
          <Section title="الالتزامات" rows={absRows(Array.isArray(d.liabilities) ? d.liabilities : [])} total={Math.abs(num(d.totalLiabilities))} totalLabel="إجمالي الالتزامات" />
          <Section title="حقوق الملكية" rows={absRows(Array.isArray(d.equity) ? d.equity : [])} total={Math.abs(num(d.totalEquity))} totalLabel="إجمالي حقوق الملكية" />
          <Card><Row bold label="الالتزامات + حقوق الملكية" value={money(Math.abs(num(d.totalLiabilitiesAndEquity)))} /></Card>
        </View>
      );
    }

    if (kind === 'income-statement') {
      return (
        <View style={{ gap: 12 }}>
          <Section title="الإيرادات" rows={Array.isArray(d.revenues) ? d.revenues : []} total={num(d.totalRevenue)} totalLabel="إجمالي الإيرادات" />
          <Section title="المصروفات" rows={Array.isArray(d.expenses) ? d.expenses : []} total={num(d.totalExpenses)} totalLabel="إجمالي المصروفات" />
          <Card><Row bold label="صافي الربح / الخسارة" value={money(num(d.netIncome))} /></Card>
        </View>
      );
    }

    if (kind === 'vat') {
      return (
        <View style={{ gap: 12 }}>
          <Card style={{ gap: 2 }}>
            {/* الشكل الحقيقي للاستجابة: outputTax.total.vat / inputTax.total.vat */}
            <Row label="ضريبة المخرجات (المبيعات)" value={money(num(d.outputTax?.total?.vat ?? d.outputTax?.vat ?? d.outputTax))} />
            <Row label="ضريبة المدخلات (المشتريات)" value={money(num(d.inputTax?.total?.vat ?? d.inputTax?.vat ?? d.inputTax))} />
            <Row bold label="صافي الضريبة المستحقة" value={money(num(d.netVat))} />
          </Card>
          <Card>
            <Text style={{ textAlign: 'right', fontSize: 12, color: c.mutedForeground, lineHeight: 20 }}>
              الفترة: {d.period?.from ?? fromDate} إلى {d.period?.to ?? toDate}. التفاصيل الكاملة (المرتجعات، التسويات، بنود الموردين) متاحة في شاشة الإقرار الضريبي على الويب.
            </Text>
          </Card>
        </View>
      );
    }
    return null;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 12, paddingHorizontal: 16, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 18, fontFamily: 'Inter_700Bold' }}>{TITLES[kind ?? ''] ?? 'تقرير'}</Text>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Feather name="x" size={22} color="#fff" />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 10 }}>
          {!isAsOf ? <Field label="من تاريخ (YYYY-MM-DD)" value={fromDate} onChangeText={setFromDate} ltr /> : null}
          <Field label={isAsOf ? 'حتى تاريخ (YYYY-MM-DD)' : 'إلى تاريخ (YYYY-MM-DD)'} value={toDate} onChangeText={setToDate} ltr />
        </Card>
        {body()}
      </ScrollView>
    </View>
  );
}
