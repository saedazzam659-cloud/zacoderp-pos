import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Empty, ErrorBox, Field } from '@/components/ui';

interface CustomerRow {
  id: number;
  code?: string;
  nameAr?: string;
  phone?: string;
  vatNumber?: string;
}

export default function Customers() {
  const { companyId, can } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [nameAr, setNameAr] = useState('');
  const [phone, setPhone] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const q = useQuery({
    queryKey: ['customers', companyId],
    queryFn: () => api<CustomerRow[]>(`/api/customers?companyId=${companyId}`),
    enabled: !!companyId,
  });

  const rows = useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : [];
    const s = search.trim();
    if (!s) return list;
    return list.filter((r) => (r.nameAr ?? '').includes(s) || (r.phone ?? '').includes(s) || (r.code ?? '').includes(s));
  }, [q.data, search]);

  const save = async () => {
    if (!nameAr.trim()) { setError('اسم العميل مطلوب'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/customers', {
        method: 'POST',
        body: { companyId, nameAr: nameAr.trim(), phone: phone.trim() || undefined, vatNumber: vatNumber.trim() || undefined },
      });
      setShowAdd(false); setNameAr(''); setPhone(''); setVatNumber('');
      qc.invalidateQueries({ queryKey: ['customers', companyId] });
    } catch (e: any) {
      setError(e?.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 14, paddingHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold' }}>العملاء</Text>
          {can('customers', 'create') && mp('customer_create') ? (
            <Pressable testID="button-new-customer" onPress={() => setShowAdd(true)} style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 12, padding: 8 }}>
              <Feather name="user-plus" size={20} color="#fff" />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12, paddingHorizontal: 10 }}>
          <Feather name="search" size={16} color="rgba(255,255,255,0.8)" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="بحث بالاسم أو الجوال"
            placeholderTextColor="rgba(255,255,255,0.7)"
            style={{ flex: 1, color: '#fff', paddingVertical: 9, textAlign: 'right', fontSize: 14 }}
          />
        </View>
      </View>

      {!mp('customers_view') ? (
        <View style={{ padding: 20 }}>
          <Empty icon="lock" text="ليست لديك صلاحية عرض العملاء من التطبيق" />
        </View>
      ) : q.isError ? (
        <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل العملاء'} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 30 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={c.primary} />}
          ListEmptyComponent={q.isLoading ? null : <Empty icon="users" text="لا يوجد عملاء بعد" />}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 13, gap: 4 }}>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 15, color: c.foreground }}>{item.nameAr ?? '—'}</Text>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{item.code ?? ''}</Text>
              </View>
              <View style={{ flexDirection: 'row-reverse', gap: 16 }}>
                {item.phone ? <Text style={{ color: c.mutedForeground, fontSize: 13 }}>📱 {item.phone}</Text> : null}
                {item.vatNumber ? <Text style={{ color: c.mutedForeground, fontSize: 13 }}>الرقم الضريبي: {item.vatNumber}</Text> : null}
              </View>
            </View>
          )}
        />
      )}

      <Modal visible={showAdd} transparent animationType="slide" onRequestClose={() => setShowAdd(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <Card style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, gap: 14, paddingBottom: 34 }}>
            <Text style={{ fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>عميل جديد</Text>
            <Field label="اسم العميل *" value={nameAr} onChangeText={setNameAr} testID="input-customer-name" />
            <Field label="الجوال" value={phone} onChangeText={setPhone} keyboardType="numeric" ltr />
            <Field label="الرقم الضريبي" value={vatNumber} onChangeText={setVatNumber} keyboardType="numeric" ltr />
            {error ? <Text style={{ color: c.destructive, fontSize: 13, textAlign: 'right' }}>{error}</Text> : null}
            <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
              <View style={{ flex: 1 }}><Btn title="حفظ" onPress={save} loading={busy} testID="button-save-customer" /></View>
              <View style={{ flex: 1 }}><Btn title="إلغاء" onPress={() => setShowAdd(false)} kind="outline" /></View>
            </View>
          </Card>
        </View>
      </Modal>
    </View>
  );
}
