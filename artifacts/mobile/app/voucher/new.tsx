import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { todayISO } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Field } from '@/components/ui';

export default function NewVoucher() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ invoiceId?: string; customerId?: string; editId?: string }>();
  const editId = params.editId ? Number(params.editId) : null;
  const { companyId } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [customerId, setCustomerId] = useState<number | null>(params.customerId ? Number(params.customerId) : null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [paymentType, setPaymentType] = useState<'cash' | 'bank'>('cash');
  const [cashBoxId, setCashBoxId] = useState<number | null>(null);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPick, setShowPick] = useState(false);
  const [search, setSearch] = useState('');

  const customersQ = useQuery({
    queryKey: ['customers', companyId],
    queryFn: () => api<any[]>(`/api/customers?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const cashBoxesQ = useQuery({
    queryKey: ['cash-boxes', companyId],
    queryFn: () => api<any[]>(`/api/cash-boxes?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const banksQ = useQuery({
    queryKey: ['bank-accounts', companyId],
    queryFn: () => api<any[]>(`/api/bank-accounts?companyId=${companyId}`),
    enabled: !!companyId,
  });

  // وضع التعديل: تحميل سند المسودة الحالي
  const editQ = useQuery({
    queryKey: ['receipt-voucher', editId],
    queryFn: () => api<any>(`/api/receipt-vouchers/${editId}?companyId=${companyId}`),
    enabled: !!companyId && !!editId,
  });
  const [editLoaded, setEditLoaded] = useState(false);
  useEffect(() => {
    const v: any = editQ.data;
    if (!v || !v.id || editLoaded) return;
    setEditLoaded(true);
    setCustomerId(v.entityId ?? null);
    setAmount(String(parseFloat(v.amount ?? 0) || ''));
    setDate(String(v.voucherDate ?? v.date ?? '').slice(0, 10) || todayISO());
    setPaymentType(v.paymentType === 'bank' ? 'bank' : 'cash');
    setCashBoxId(v.cashBoxId ?? null);
    setBankAccountId(v.bankAccountId ?? null);
    setDescription(v.description ?? '');
  }, [editQ.data, editLoaded]);

  const customers = Array.isArray(customersQ.data) ? customersQ.data : [];
  const cashBoxes = Array.isArray(cashBoxesQ.data) ? cashBoxesQ.data : [];
  const banks = Array.isArray(banksQ.data) ? banksQ.data : [];
  const customer = useMemo(() => customers.find((x) => x.id === customerId) ?? null, [customers, customerId]);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!customerId) { setError('اختر العميل'); return; }
    if (!amt || amt <= 0) { setError('أدخل مبلغاً صحيحاً'); return; }
    if (paymentType === 'cash' && !cashBoxId && cashBoxes.length > 0) { setError('اختر الصندوق'); return; }
    if (paymentType === 'bank' && !bankAccountId) { setError('اختر الحساب البنكي'); return; }
    setBusy(true); setError('');
    try {
      const body = {
        companyId,
        entityType: 'customer',
        entityId: customerId,
        salesInvoiceId: params.invoiceId ? Number(params.invoiceId) : undefined,
        date,
        amount: amt,
        paymentType,
        cashBoxId: paymentType === 'cash' ? cashBoxId : undefined,
        bankAccountId: paymentType === 'bank' ? bankAccountId : undefined,
        description: description || undefined,
      };
      let newId: number | null;
      if (editId) {
        await api(`/api/receipt-vouchers/${editId}?companyId=${companyId}`, { method: 'PUT', body });
        newId = editId;
      } else {
        const created = await api<any>('/api/receipt-vouchers', { method: 'POST', body });
        newId = created?.id ?? created?.voucher?.id;
      }
      if (newId && !editId) {
        // vouchers are created as drafts — post so the receipt hits the ledger
        await api(`/api/receipt-vouchers/${newId}/post`, { method: 'POST', body: { companyId } });
      }
      qc.invalidateQueries({ queryKey: ['receipt-vouchers'] });
      qc.invalidateQueries({ queryKey: ['invoice-vouchers'] });
      if (Platform.OS !== 'web') Alert.alert('تم', 'تم حفظ سند القبض');
      router.back();
    } catch (e: any) {
      setError(e?.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const PickRow = ({ label, value, onPress, testID }: { label: string; value: string; onPress: () => void; testID?: string }) => (
    <Pressable testID={testID} onPress={onPress} style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 12, backgroundColor: c.card }}>
      <Text style={{ fontSize: 13, color: c.mutedForeground }}>{label}</Text>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: 14, color: c.foreground, fontFamily: 'Inter_500Medium' }}>{value}</Text>
        <Feather name="chevron-down" size={16} color={c.mutedForeground} />
      </View>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 14, paddingHorizontal: 14, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' }}>{editId ? 'تعديل سند قبض' : 'سند قبض جديد'}</Text>
        <Pressable onPress={() => router.back()} hitSlop={10}><Feather name="x" size={22} color="#fff" /></Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 12 }}>
          <PickRow label="العميل *" value={customer?.nameAr ?? 'اختر عميلاً'} onPress={() => setShowPick(true)} testID="pick-voucher-customer" />
          <Field label="المبلغ *" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" ltr testID="input-voucher-amount" />
          <Field label="التاريخ (YYYY-MM-DD)" value={date} onChangeText={setDate} ltr />
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>طريقة القبض</Text>
          <View style={{ flexDirection: 'row-reverse', backgroundColor: c.muted, borderRadius: 12, padding: 3 }}>
            {(['cash', 'bank'] as const).map((v) => (
              <Pressable key={v} onPress={() => setPaymentType(v)} style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: paymentType === v ? c.card : 'transparent', alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: paymentType === v ? c.primary : c.mutedForeground, fontFamily: paymentType === v ? 'Inter_600SemiBold' : 'Inter_400Regular' }}>
                  {v === 'cash' ? 'نقدي' : 'بنك/شبكة'}
                </Text>
              </Pressable>
            ))}
          </View>
          {paymentType === 'cash' && cashBoxes.length > 0 ? (
            <PickRow label="الصندوق" value={cashBoxes.find((b) => b.id === cashBoxId)?.nameAr ?? 'اختر'} onPress={() => {
              const idx = cashBoxes.findIndex((b) => b.id === cashBoxId);
              setCashBoxId(cashBoxes[(idx + 1) % cashBoxes.length]?.id ?? null);
            }} />
          ) : null}
          {paymentType === 'bank' ? (
            <PickRow label="الحساب البنكي" value={banks.find((b) => b.id === bankAccountId)?.nameAr ?? 'اختر'} onPress={() => {
              const idx = banks.findIndex((b) => b.id === bankAccountId);
              setBankAccountId(banks[(idx + 1) % banks.length]?.id ?? null);
            }} />
          ) : null}
          <Field label="البيان" value={description} onChangeText={setDescription} multiline />
        </Card>
        {error ? <Text style={{ color: c.destructive, textAlign: 'right', fontSize: 13 }}>{error}</Text> : null}
        {mp(editId ? 'voucher_edit' : 'voucher_create') ? (
          <Btn title="حفظ السند" onPress={save} loading={busy} icon="check" testID="button-save-voucher" />
        ) : (
          <Card><Text style={{ textAlign: 'right', color: c.destructive }}>{editId ? 'ليست لديك صلاحية تعديل السندات من التطبيق — تواصل مع مدير النظام.' : 'ليست لديك صلاحية إنشاء سند قبض من التطبيق — تواصل مع مدير النظام.'}</Text></Card>
        )}
      </ScrollView>

      <Modal visible={showPick} transparent animationType="slide" onRequestClose={() => setShowPick(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>اختيار العميل</Text>
            <TextInput value={search} onChangeText={setSearch} placeholder="بحث..." placeholderTextColor={c.mutedForeground} style={{ borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 10, textAlign: 'right', color: c.foreground }} />
            <FlatList
              data={customers.filter((x) => !search.trim() || (x.nameAr ?? '').includes(search.trim()))}
              keyExtractor={(x) => String(x.id)}
              renderItem={({ item }) => (
                <Pressable onPress={() => { setCustomerId(item.id); setShowPick(false); }} style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1 })}>
                  <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>{item.nameAr}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
