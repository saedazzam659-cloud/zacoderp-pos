import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Card, Btn, Empty, ErrorBox } from '@/components/ui';
import { useGetCashExpenses, useGetCashExpenseReport, getGetCashExpensesQueryKey, getGetCashExpenseReportQueryKey } from '@workspace/api-client-react';
import type { CashExpense } from '@workspace/api-client-react';

const today = new Date();
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const monthStart = dateKey(new Date(today.getFullYear(), today.getMonth(), 1));
const todayString = dateKey(today);

export default function CashExpensesList() {
  const router = useRouter();
  const c = useColors();
  const { mp } = useMobilePerms();
  const canViewOwn = mp('cash_expenses_view_own');
  const canViewAll = mp('cash_expenses_view_all');
  const canCreate = mp('cash_expenses_create');
  const canReport = mp('cash_expenses_report');
  const [tab, setTab] = useState<'expenses' | 'report'>('expenses');
  const params = useMemo(() => ({}), []);
  const listQuery = useGetCashExpenses(params, { query: { queryKey: getGetCashExpensesQueryKey(params), enabled: canViewOwn || canViewAll } });
  const fromTo = useMemo(() => ({ from: monthStart, to: todayString }), []);
  const reportQuery = useGetCashExpenseReport(fromTo, { query: { queryKey: getGetCashExpenseReportQueryKey(fromTo), enabled: canReport && tab === 'report' } });
  const rows = Array.isArray(listQuery.data) ? listQuery.data as CashExpense[] : [];
  const visibleRows = canViewAll ? rows : rows.filter((row) => row.isMine);
  const report = reportQuery.data;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <CashHeader title="المصروفات النقدية" onBack={() => router.back()} right={canCreate ? <Pressable onPress={() => router.push('/cash-expenses/new')} hitSlop={8} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.primaryForeground + '20', alignItems: 'center', justifyContent: 'center' }}><Feather name="plus" size={21} color={c.primaryForeground} /></Pressable> : undefined} />
      <View style={{ flexDirection: 'row-reverse', gap: 8, padding: 14, paddingBottom: 4 }}>
        <Pressable onPress={() => setTab('expenses')} style={{ flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 11, backgroundColor: tab === 'expenses' ? c.primary : c.card, borderWidth: 1, borderColor: tab === 'expenses' ? c.primary : c.border }}>
          <Feather name="list" size={15} color={tab === 'expenses' ? c.primaryForeground : c.mutedForeground} /><Text style={{ color: tab === 'expenses' ? c.primaryForeground : c.foreground, fontSize: 13, fontFamily: 'Inter_600SemiBold' }}>السجل</Text>
        </Pressable>
        {canReport ? <Pressable onPress={() => setTab('report')} style={{ flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 11, backgroundColor: tab === 'report' ? c.primary : c.card, borderWidth: 1, borderColor: tab === 'report' ? c.primary : c.border }}>
          <Feather name="bar-chart-2" size={15} color={tab === 'report' ? c.primaryForeground : c.mutedForeground} /><Text style={{ color: tab === 'report' ? c.primaryForeground : c.foreground, fontSize: 13, fontFamily: 'Inter_600SemiBold' }}>تقرير المرحّل</Text>
        </Pressable> : null}
      </View>

      {tab === 'expenses' ? (
        !canViewOwn && !canViewAll ? <View style={{ padding: 18 }}><Card><Text style={{ color: c.mutedForeground, textAlign: 'right', lineHeight: 22 }}>لا تملك صلاحية عرض المصروفات النقدية.</Text></Card></View>
          : listQuery.isLoading ? <LoadingBlock />
          : listQuery.isError ? <ErrorBox text={(listQuery.error as Error)?.message ?? 'تعذّر تحميل المصروفات'} onRetry={() => listQuery.refetch()} />
          : <FlatList
            data={visibleRows}
            keyExtractor={(item) => String(item.id)}
            refreshControl={<RefreshControl refreshing={listQuery.isRefetching} onRefresh={() => listQuery.refetch()} tintColor={c.primary} />}
            contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: Platform.OS === 'web' ? 34 : 28, flexGrow: 1 }}
            ItemSeparatorComponent={() => <View style={{ height: 9 }} />}
            ListHeaderComponent={<View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2, paddingBottom: 10 }}><SectionLabel>{visibleRows.length} سجل</SectionLabel><SectionLabel>{canViewAll ? 'كل المصروفات المسموح بها' : 'مصروفاتي'}</SectionLabel></View>}
            ListEmptyComponent={<Card><Empty icon="credit-card" text="لا توجد مصروفات للعرض حالياً" />{canCreate ? <Btn title="تسجيل مصروف" icon="plus" onPress={() => router.push('/cash-expenses/new')} /> : null}</Card>}
            renderItem={({ item }) => <ExpenseRow item={item} onPress={() => router.push(`/cash-expenses/${item.id}`)} />}
          />
      ) : (
        !canReport ? <View style={{ padding: 18 }}><Card><Text style={{ color: c.mutedForeground, textAlign: 'right' }}>لا تملك صلاحية عرض التقرير.</Text></Card></View>
          : reportQuery.isLoading ? <LoadingBlock />
          : reportQuery.isError ? <ErrorBox text={(reportQuery.error as Error)?.message ?? 'تعذّر تحميل التقرير'} onRetry={() => reportQuery.refetch()} />
          : <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: Platform.OS === 'web' ? 34 : 24 }}>
            <Card style={{ backgroundColor: c.primary, borderColor: c.primary, gap: 8 }}>
              <Text style={{ color: c.primaryForeground + 'B8', textAlign: 'right', fontSize: 12, fontFamily: 'Inter_500Medium' }}>إجمالي المصروفات المرحلة · هذا الشهر</Text>
              <Text style={{ color: c.primaryForeground, textAlign: 'right', fontSize: 29, fontFamily: 'Inter_700Bold', writingDirection: 'ltr' }}>{report?.totalAmount == null && report?.rows?.length ? '—' : Number(report?.totalAmount ?? 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{report?.currencyCode ? ` ${report.currencyCode}` : ''}</Text>
              {report?.totalAmount == null && report?.rows?.length ? <Text style={{ color: c.primaryForeground + 'D0', textAlign: 'right', fontSize: 11 }}>الإجمالي غير موحّد لاختلاف العملات؛ راجع المبالغ لكل خزنة.</Text> : null}
              <Text style={{ color: c.primaryForeground + 'D0', textAlign: 'right', fontSize: 12 }}>{report?.count ?? 0} مصروف · {fromTo.from} — {fromTo.to}</Text>
            </Card>
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 }}><SectionLabel>{report?.rows?.length ?? 0} تجميعات</SectionLabel><Text style={{ color: c.foreground, fontSize: 16, textAlign: 'right', fontFamily: 'Inter_700Bold' }}>حسب الصندوق والحساب</Text></View>
            {!report?.rows?.length ? <Card><Empty icon="bar-chart-2" text="لا توجد مصروفات مرحلة ضمن الفترة" /></Card> : report.rows.map((row, i) => <Card key={`${row.cashBoxId}-${row.expenseAccountId}-${i}`} style={{ gap: 11 }}>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}><View style={{ flex: 1, gap: 4 }}><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>{row.cashBoxName}</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{row.expenseAccountName}</Text></View><Amount value={row.amount} currencyCode={row.currencyCode} /></View>
              <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 8, flexDirection: 'row-reverse', justifyContent: 'space-between' }}><SectionLabel>عدد القيود</SectionLabel><Text style={{ color: c.foreground, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>{row.count}</Text></View>
            </Card>)}
          </ScrollView>
      )}
    </View>
  );
}

function ExpenseRow({ item, onPress }: { item: CashExpense; onPress: () => void }) {
  const c = useColors();
  return <Pressable onPress={onPress} accessibilityRole="button" testID={`cash-expense-${item.id}`} style={({ pressed }) => ({ opacity: pressed ? 0.82 : 1 })}>
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flex: 1, gap: 5 }}>
          <View style={{ flexDirection: 'row-reverse', gap: 7, alignItems: 'center' }}><Text numberOfLines={1} style={{ color: c.foreground, fontSize: 15, fontFamily: 'Inter_700Bold', flexShrink: 1 }}>{item.description}</Text>{item.receiptAvailable ? <Feather name="paperclip" size={13} color={c.mutedForeground} /> : null}</View>
          <Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{item.code} · {String(item.date).slice(0, 10)}</Text>
        </View>
        <StatusPill status={item.status} />
      </View>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderColor: c.border, paddingTop: 10 }}>
        <View style={{ gap: 3 }}><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 12, fontFamily: 'Inter_500Medium' }}>{item.cashBoxName}</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 11 }}>{item.expenseAccountName}{item.employeeName ? ` · ${item.employeeName}` : ''}</Text></View>
        <Amount value={item.amount} currencyCode={item.currencyCode} />
      </View>
    </Card>
  </Pressable>;
}

function CashHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return <View style={{ backgroundColor: c.primary, paddingTop: top + 10, paddingHorizontal: 18, paddingBottom: 18, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
    <Pressable onPress={onBack} hitSlop={10}><Feather name="arrow-right" size={21} color={c.primaryForeground} /></Pressable>
    <Text style={{ flex: 1, textAlign: 'right', marginHorizontal: 16, color: c.primaryForeground, fontSize: 19, fontFamily: 'Inter_700Bold' }}>{title}</Text>
    {right ?? <View style={{ width: 22 }} />}
  </View>;
}
function SectionLabel({ children }: { children: React.ReactNode }) { const c = useColors(); return <Text style={{ color: c.mutedForeground, fontSize: 12, textAlign: 'right', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 }}>{children}</Text>; }
function StatusPill({ status }: { status: string }) {
  const c = useColors();
  const tint = status === 'posted' ? c.primary : status === 'cancelled' ? c.destructive : c.mutedForeground;
  const label = status === 'posted' ? 'مرحّل' : status === 'cancelled' ? 'ملغي' : 'مسودة';
  return <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 5, backgroundColor: tint + '18', borderRadius: 20, paddingVertical: 5, paddingHorizontal: 9 }}><View style={{ width: 6, height: 6, borderRadius: 4, backgroundColor: tint }} /><Text style={{ color: tint, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>{label}</Text></View>;
}
function LoadingBlock() { const c = useColors(); return <View style={{ padding: 24, gap: 12 }}>{[0, 1, 2].map((n) => <View key={n} style={{ height: n === 0 ? 82 : 58, borderRadius: 12, backgroundColor: c.muted, opacity: 0.65 }} />)}<ActivityIndicator color={c.primary} style={{ marginTop: 4 }} /></View>; }
function Amount({ value, currencyCode }: { value: number; currencyCode?: string | null }) { const c = useColors(); return <Text style={{ color: c.primary, fontSize: 17, fontFamily: 'Inter_700Bold', writingDirection: 'ltr' }}>{Number(value || 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{currencyCode ? ` ${currencyCode}` : ''}</Text>; }
