import React, { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, showDate } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Empty, ErrorBox } from '@/components/ui';

interface InvoiceRow {
  id: number;
  docNumber?: string;
  invoiceDate?: string;
  customerName?: string;
  customer?: { nameAr?: string };
  totalAmount?: number | string;
  status?: string;
  paymentType?: string;
  zatcaStatus?: string;
}

const STATUS_AR: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  draft: { label: 'مسودة', tone: 'muted' },
  posted: { label: 'مرحّلة', tone: 'ok' },
  issued: { label: 'صادرة', tone: 'ok' },
  cancelled: { label: 'ملغاة', tone: 'warn' },
};

export default function Invoices() {
  const { companyId } = useAuth();
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['sales-invoices', companyId],
    queryFn: () => api<InvoiceRow[]>(`/api/sales/sales-invoices?companyId=${companyId}`),
    enabled: !!companyId,
  });

  const rows = useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : [];
    const s = search.trim();
    if (!s) return list;
    return list.filter(
      (r) =>
        (r.docNumber ?? '').includes(s) ||
        (r.customerName ?? r.customer?.nameAr ?? '').includes(s),
    );
  }, [q.data, search]);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 14, paddingHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold' }}>فواتير المبيعات</Text>
          <Pressable
            testID="button-new-invoice"
            onPress={() => router.push('/invoice/new')}
            style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 12, padding: 8 }}
          >
            <Feather name="plus" size={20} color="#fff" />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12, paddingHorizontal: 10 }}>
          <Feather name="search" size={16} color="rgba(255,255,255,0.8)" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="بحث برقم الفاتورة أو اسم العميل"
            placeholderTextColor="rgba(255,255,255,0.7)"
            style={{ flex: 1, color: '#fff', paddingVertical: 9, textAlign: 'right', fontSize: 14 }}
          />
        </View>
      </View>

      {q.isError ? (
        <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل الفواتير'} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 30 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={c.primary} />}
          ListEmptyComponent={
            q.isLoading ? null : <Empty icon="file-text" text="لا توجد فواتير بعد — اضغط + لإنشاء فاتورة" />
          }
          renderItem={({ item }) => {
            const st = STATUS_AR[item.status ?? ''] ?? { label: item.status ?? '—', tone: 'muted' as const };
            const stColor = st.tone === 'ok' ? c.success : st.tone === 'warn' ? c.destructive : c.mutedForeground;
            return (
              <Pressable
                testID={`card-invoice-${item.id}`}
                onPress={() => router.push(`/invoice/${item.id}`)}
                style={({ pressed }) => ({
                  backgroundColor: c.card,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: c.border,
                  padding: 13,
                  gap: 6,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 15, color: c.foreground }}>
                    {item.docNumber ?? `#${item.id}`}
                  </Text>
                  <View style={{ backgroundColor: `${stColor}18`, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                    <Text style={{ color: stColor, fontSize: 12, fontFamily: 'Inter_500Medium' }}>{st.label}</Text>
                  </View>
                </View>
                <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 13 }}>
                  {item.customerName ?? item.customer?.nameAr ?? 'عميل نقدي'}
                </Text>
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                  <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{showDate(item.invoiceDate)}</Text>
                  <Text style={{ color: c.primary, fontSize: 15, fontFamily: 'Inter_700Bold' }}>
                    {money(item.totalAmount)}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
