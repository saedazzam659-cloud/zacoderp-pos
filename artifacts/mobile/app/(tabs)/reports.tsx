import React, { useMemo } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Card, ErrorBox } from '@/components/ui';

export default function Summary() {
  const { companyId, can } = useAuth();
  const { mp } = useMobilePerms();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const q = useQuery({
    queryKey: ['sales-invoices', companyId],
    queryFn: () => api<any[]>(`/api/sales/sales-invoices?companyId=${companyId}`),
    enabled: !!companyId,
  });

  const stats = useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : [];
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = `${ym}-${String(now.getDate()).padStart(2, '0')}`;
    let todayTotal = 0, todayCount = 0, monthTotal = 0, monthCount = 0, draftCount = 0;
    for (const r of list) {
      const d = String(r.invoiceDate ?? '').slice(0, 10);
      const amt = parseFloat(r.totalAmount ?? 0) || 0;
      if (r.status === 'draft') draftCount++;
      if (d === today) { todayTotal += amt; todayCount++; }
      if (d.startsWith(ym)) { monthTotal += amt; monthCount++; }
    }
    return { todayTotal, todayCount, monthTotal, monthCount, draftCount, total: list.length };
  }, [q.data]);

  const Stat = ({ icon, label, value, sub }: { icon: keyof typeof Feather.glyphMap; label: string; value: string; sub?: string }) => (
    <Card style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8 }}>
        <Feather name={icon} size={16} color={c.primary} />
        <Text style={{ fontSize: 12, color: c.mutedForeground }}>{label}</Text>
      </View>
      <Text style={{ fontSize: 19, fontFamily: 'Inter_700Bold', textAlign: 'right', color: c.foreground }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 11, color: c.mutedForeground, textAlign: 'right' }}>{sub}</Text> : null}
    </Card>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 16, paddingHorizontal: 16 }}>
        <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold', textAlign: 'right' }}>ملخص المبيعات</Text>
      </View>
      {!mp('reports_view') ? (
        <View style={{ padding: 20 }}>
          <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>ليست لديك صلاحية عرض التقارير من التطبيق.</Text></Card>
          {(mp('customer_statement_view') || mp('customer_statement_detailed_view')) && <Card style={{ marginTop: 12, gap: 12 }}>
            {mp('customer_statement_view') && <Pressable onPress={() => router.push('/customer-statement/ordinary' as any)}><Text style={{ color: c.primary, textAlign: 'right' }}>كشف حساب عميل ←</Text></Pressable>}
            {mp('customer_statement_detailed_view') && <Pressable onPress={() => router.push('/customer-statement/detailed' as any)}><Text style={{ color: c.primary, textAlign: 'right' }}>كشف حساب عميل تفصيلي ←</Text></Pressable>}
          </Card>}
        </View>
      ) : q.isError ? (
        <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل البيانات'} onRetry={() => q.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row-reverse', gap: 12 }}>
            <Stat icon="sun" label="مبيعات اليوم" value={money(stats.todayTotal)} sub={`${stats.todayCount} فاتورة`} />
            <Stat icon="calendar" label="مبيعات الشهر" value={money(stats.monthTotal)} sub={`${stats.monthCount} فاتورة`} />
          </View>
          <View style={{ flexDirection: 'row-reverse', gap: 12 }}>
            <Stat icon="file-text" label="إجمالي الفواتير" value={String(stats.total)} />
            <Stat icon="edit-3" label="مسودات" value={String(stats.draftCount)} />
          </View>
          {(mp('customer_statement_view') || mp('customer_statement_detailed_view')) && (
            <Card style={{ gap: 8 }}>
              <Text style={{ color: c.foreground, textAlign: 'right', fontFamily: 'Inter_700Bold' }}>كشوف حساب العملاء</Text>
              {mp('customer_statement_view') && <Pressable onPress={() => router.push('/customer-statement/ordinary' as any)} style={{ padding: 10 }}><Text style={{ color: c.primary, textAlign: 'right' }}>كشف حساب عميل ←</Text></Pressable>}
              {mp('customer_statement_detailed_view') && <Pressable onPress={() => router.push('/customer-statement/detailed' as any)} style={{ padding: 10 }}><Text style={{ color: c.primary, textAlign: 'right' }}>كشف حساب عميل تفصيلي ←</Text></Pressable>}
            </Card>
          )}
          {can('accounting_reports', 'view') || can('vat_declaration', 'view') ? (
            <View style={{ gap: 10 }}>
              <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', textAlign: 'right', color: c.foreground, marginTop: 4 }}>التقارير المالية</Text>
              {[
                ...(can('accounting_reports', 'view')
                  ? [
                      { kind: 'trial-balance', label: 'ميزان المراجعة', icon: 'bar-chart-2' as const },
                      { kind: 'balance-sheet', label: 'قائمة المركز المالي', icon: 'layers' as const },
                      { kind: 'income-statement', label: 'قائمة الدخل (أرباح وخسائر)', icon: 'trending-up' as const },
                    ]
                  : []),
                ...(can('vat_declaration', 'view') ? [{ kind: 'vat', label: 'الإقرار الضريبي', icon: 'percent' as const }] : []),
              ].map((r) => (
                <Pressable
                  key={r.kind}
                  testID={`report-${r.kind}`}
                  onPress={() => router.push(`/report/${r.kind}` as any)}
                  style={({ pressed }) => ({ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 14, flexDirection: 'row-reverse', alignItems: 'center', gap: 10, opacity: pressed ? 0.7 : 1 })}
                >
                  <Feather name={r.icon} size={18} color={c.primary} />
                  <Text style={{ flex: 1, textAlign: 'right', fontSize: 14, fontFamily: 'Inter_500Medium', color: c.foreground }}>{r.label}</Text>
                  <Feather name="chevron-left" size={16} color={c.mutedForeground} />
                </Pressable>
              ))}
            </View>
          ) : (
            <Card>
              <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>
                لا تملك صلاحية عرض التقارير المالية — تواصل مع مدير النظام.
              </Text>
            </Card>
          )}
        </ScrollView>
      )}
    </View>
  );
}
