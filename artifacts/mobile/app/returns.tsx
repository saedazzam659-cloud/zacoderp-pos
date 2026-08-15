import React from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, showDate } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Empty } from '@/components/ui';

// شاشة مرتجع المبيعات — تعرض كل المرتجعات (بما فيها المُنشأة من داخل الفاتورة)
export default function SalesReturnsList() {
  const router = useRouter();
  const { companyId } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const listQ = useQuery({
    queryKey: ['sales-returns', companyId],
    queryFn: () => api<any[]>(`/api/sales/sales-returns?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const rows = Array.isArray(listQ.data) ? listQ.data : [];

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 12, paddingHorizontal: 14, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' }}>مرتجع المبيعات</Text>
        <View style={{ flexDirection: 'row-reverse', gap: 14, alignItems: 'center' }}>
          {mp('return_create') ? (
            <Pressable testID="button-new-return" onPress={() => router.push('/return/new' as any)} hitSlop={8}>
              <Feather name="plus-circle" size={22} color="#fff" />
            </Pressable>
          ) : null}
          <Pressable onPress={() => router.back()} hitSlop={8} testID="button-close-returns">
            <Feather name="x" size={22} color="#fff" />
          </Pressable>
        </View>
      </View>

      {!mp('returns_view') ? (
        <View style={{ padding: 20 }}>
          <Empty icon="lock" text="ليست لديك صلاحية عرض المرتجعات من التطبيق" />
        </View>
      ) : listQ.isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(x: any) => String(x.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          ListEmptyComponent={<Empty icon="corner-up-right" text="لا توجد مرتجعات بعد" />}
          renderItem={({ item }: any) => {
            const posted = item.status && item.status !== 'draft';
            return (
              <Pressable
                testID={`return-row-${item.id}`}
                onPress={() => router.push(`/return/${item.id}` as any)}
                style={({ pressed }) => ({ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12, gap: 6, opacity: pressed ? 0.7 : 1 })}
              >
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: c.foreground }}>
                    {item.docNumber ?? `مرتجع #${item.id}`}
                  </Text>
                  <Text style={{ color: c.destructive, fontFamily: 'Inter_700Bold', fontSize: 15 }}>{money(item.totalAmount)}</Text>
                </View>
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, color: c.mutedForeground, textAlign: 'right' }}>
                    {showDate(item.returnDate)}{item.customerName ? ` · ${item.customerName}` : ''}{item.invoiceId ? ' · من فاتورة' : ''}
                  </Text>
                  <View style={{ backgroundColor: posted ? '#dcfce7' : c.muted, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 }}>
                    <Text style={{ fontSize: 11, color: posted ? '#166534' : c.mutedForeground }}>{posted ? 'مرحّل' : 'مسودة'}</Text>
                  </View>
                </View>
              </Pressable>
            );
          }}
          refreshing={listQ.isFetching}
          onRefresh={() => listQ.refetch()}
        />
      )}
    </View>
  );
}
