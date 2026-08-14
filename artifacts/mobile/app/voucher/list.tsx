import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Card, ErrorBox } from '@/components/ui';

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') window.alert(`${title}: ${msg}`);
  else Alert.alert(title, msg);
}

/** سندات القبض — قائمة مع فك الترحيل (نفس سياسة الويب: الخادم يفرض مصفوفة صلاحيات الترحيل) */
export default function VoucherList() {
  const { companyId, can } = useAuth();
  const router = useRouter();
  const c = useColors();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const [busyId, setBusyId] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['receipt-vouchers', companyId],
    queryFn: () => api<any[]>(`/api/receipt-vouchers?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const rows = Array.isArray(q.data) ? q.data : [];

  const doUnpost = (v: any) => {
    const go = async () => {
      setBusyId(v.id);
      try {
        await api(`/api/receipt-vouchers/${v.id}/unpost?companyId=${companyId}`, { method: 'POST', body: { companyId } });
        await qc.invalidateQueries({ queryKey: ['receipt-vouchers'] });
        notify('تم', 'تم فك ترحيل السند — أصبح مسودة');
      } catch (e: any) {
        notify('تعذّر فك الترحيل', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setBusyId(null);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('فك الترحيل', `سيتم حذف قيد السند ${v.voucherNumber ?? v.id} ويصبح مسودة. متابعة؟`, [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'فك الترحيل', style: 'destructive', onPress: go },
    ]);
  };

  const canUnpost = can('receipt_vouchers', 'post');

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 12, paddingHorizontal: 16, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 18, fontFamily: 'Inter_700Bold' }}>سندات القبض</Text>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Feather name="x" size={22} color="#fff" />
        </Pressable>
      </View>
      {q.isLoading ? (
        <ActivityIndicator color={c.primary} size="large" style={{ marginTop: 40 }} />
      ) : q.isError ? (
        <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل السندات'} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(v) => String(v.id)}
          contentContainerStyle={{ padding: 14, gap: 10 }}
          ListEmptyComponent={<Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا توجد سندات قبض</Text></Card>}
          renderItem={({ item: v }) => {
            const posted = v.status === 'posted';
            return (
              <Card style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{v.voucherNumber ?? `#${v.id}`}</Text>
                  <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', color: c.primary }}>{money(parseFloat(v.amount ?? 0) || 0)}</Text>
                </View>
                <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, color: c.mutedForeground }}>
                    {String(v.voucherDate ?? v.date ?? '').slice(0, 10)}
                    {'  ·  '}
                    {posted ? 'مرحّل' : v.status === 'draft' ? 'مسودة' : String(v.status ?? '')}
                  </Text>
                  {posted && canUnpost ? (
                    <Pressable
                      testID={`unpost-voucher-${v.id}`}
                      disabled={busyId === v.id}
                      onPress={() => doUnpost(v)}
                      style={({ pressed }) => ({ flexDirection: 'row-reverse', alignItems: 'center', gap: 6, backgroundColor: pressed ? c.muted : 'transparent', borderWidth: 1, borderColor: c.destructive, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, opacity: busyId === v.id ? 0.5 : 1 })}
                    >
                      {busyId === v.id ? <ActivityIndicator size="small" color={c.destructive} /> : <Feather name="rotate-ccw" size={13} color={c.destructive} />}
                      <Text style={{ fontSize: 12, color: c.destructive, fontFamily: 'Inter_500Medium' }}>فك الترحيل</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Card>
            );
          }}
        />
      )}
    </View>
  );
}
