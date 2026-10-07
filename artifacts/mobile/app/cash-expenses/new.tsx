import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, ErrorBox, Field } from '@/components/ui';
import { useCreateCashExpense, useUpdateCashExpense, useGetCashExpense, useGetCashExpenseOptions, useUploadCashExpenseReceipt, useDeleteCashExpenseReceiptUpload, getGetCashExpenseOptionsQueryKey, getGetCashExpenseQueryKey, getGetCashExpensesQueryKey } from '@workspace/api-client-react';
import type { CashExpense, CashExpenseCashBoxOption, CashExpenseAccountOption } from '@workspace/api-client-react';

function notify(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
  else Alert.alert(title, message);
}
const dateKey = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

export default function CashExpenseEditor() {
  const params = useLocalSearchParams<{ editId?: string }>();
  const editId = Number(params.editId) || 0;
  const { mp } = useMobilePerms();
  const allowed = editId ? mp('cash_expenses_edit') && (mp('cash_expenses_view_own') || mp('cash_expenses_view_all')) : mp('cash_expenses_create');
  return <EditorBody editId={editId} allowed={allowed} />;
}

function EditorBody({ editId, allowed }: { editId: number; allowed: boolean }) {
  const router = useRouter();
  const c = useColors();
  const qc = useQueryClient();
  const optionsQuery = useGetCashExpenseOptions({ query: { queryKey: getGetCashExpenseOptionsQueryKey(), enabled: allowed } });
  const existingQuery = useGetCashExpense(editId, { query: { queryKey: getGetCashExpenseQueryKey(editId), enabled: allowed && !!editId } });
  const createMutation = useCreateCashExpense();
  const updateMutation = useUpdateCashExpense();
  const uploadMutation = useUploadCashExpenseReceipt();
  const deleteReceiptMutation = useDeleteCashExpenseReceiptUpload();
  const existing = existingQuery.data as CashExpense | undefined;
  const [cashBoxId, setCashBoxId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [receipt, setReceipt] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [removeExistingReceipt, setRemoveExistingReceipt] = useState(false);
  const [picker, setPicker] = useState<'cashbox' | 'account' | null>(null);
  const [saving, setSaving] = useState(false);
  const initialized = React.useRef(false);

  React.useEffect(() => {
    if (!optionsQuery.data || (editId > 0 && !existingQuery.data) || initialized.current) return;
    initialized.current = true;
    const seed = existing;
    setDate(seed?.date?.slice(0, 10) ?? dateKey(new Date()));
    setAmount(seed ? String(seed.amount) : '');
    setDescription(seed?.description ?? '');
    setCashBoxId(seed?.cashBoxId ?? optionsQuery.data.defaultCashBoxId);
    setAccountId(seed?.expenseAccountId ?? null);
    setRemoveExistingReceipt(false);
  }, [optionsQuery.data, existing, existingQuery.data, editId]);

  if (!allowed) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="مصروف نقدي" onBack={() => router.back()} /><View style={{ padding: 18 }}><Card><Text style={{ textAlign: 'right', color: c.mutedForeground, lineHeight: 22 }}>لا تملك الصلاحية اللازمة لإنشاء هذا المصروف أو تعديله.</Text></Card></View></View>;
  if (optionsQuery.isLoading || (editId > 0 && existingQuery.isLoading)) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title={editId ? 'تعديل المسودة' : 'مصروف جديد'} onBack={() => router.back()} /><LoadingBlock /></View>;
  if (optionsQuery.isError) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="مصروف جديد" onBack={() => router.back()} /><ErrorBox text={(optionsQuery.error as Error)?.message ?? 'تعذّر تحميل الصناديق والحسابات'} onRetry={() => optionsQuery.refetch()} /></View>;
  if (editId && (existingQuery.isError || !existing)) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="تعديل المسودة" onBack={() => router.back()} /><ErrorBox text={(existingQuery.error as Error)?.message ?? 'تعذّر تحميل المسودة'} onRetry={() => existingQuery.refetch()} /></View>;

  const options = optionsQuery.data;
  const cashBox = options?.cashBoxes.find((item) => item.id === cashBoxId);
  const account = options?.expenseAccounts.find((item) => item.id === accountId);
  const busy = saving || createMutation.isPending || updateMutation.isPending || uploadMutation.isPending;
  const chooseReceipt = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, base64: true, quality: 0.82 });
    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      const suffix = asset.fileName?.split('.').pop()?.toLowerCase();
      const mime = asset.mimeType ?? (suffix === 'png' ? 'image/png' : suffix === 'webp' ? 'image/webp' : suffix === 'jpg' || suffix === 'jpeg' ? 'image/jpeg' : null);
      if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
        notify('صيغة الصورة غير مدعومة', 'اختر صورة بصيغة JPEG أو PNG أو WebP.');
        return;
      }
      setRemoveExistingReceipt(false);
      setReceipt({ ...asset, mimeType: mime });
    } else if (!result.canceled) notify('تعذّر إرفاق الصورة', 'لم يتمكن التطبيق من قراءة محتوى الصورة. اختر صورة أخرى.');
  };

  const save = async () => {
    const numericAmount = Number(amount.replace(/,/g, ''));
    if (!cashBoxId || !accountId || !date.trim() || !Number.isFinite(numericAmount) || numericAmount <= 0 || !description.trim()) {
      notify('راجع البيانات', 'أدخل التاريخ والصندوق والحساب والمبلغ ووصفاً للمصروف.');
      return;
    }
    setSaving(true);
    let stagedPath: string | null = null;
    try {
      if (receipt) {
        const mimeType = receipt.mimeType as 'image/jpeg' | 'image/png' | 'image/webp';
        const uploaded = await uploadMutation.mutateAsync({ data: { mimeType, base64: receipt.base64! } });
        stagedPath = uploaded.objectPath;
      }
      const data = { date, cashBoxId, expenseAccountId: accountId, amount: numericAmount, description: description.trim(), ...(stagedPath ? { receiptPath: stagedPath } : editId && removeExistingReceipt ? { receiptPath: null } : {}) };
      if (editId) await updateMutation.mutateAsync({ id: editId, data });
      else await createMutation.mutateAsync({ data });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetCashExpensesQueryKey() }),
        ...(editId ? [qc.invalidateQueries({ queryKey: getGetCashExpenseQueryKey(editId) })] : []),
      ]);
      notify('تم الحفظ', editId ? 'تم تحديث المسودة بنجاح.' : 'تم حفظ المصروف كمسودة.');
      router.replace(editId ? `/cash-expenses/${editId}` : '/cash-expenses');
    } catch (error: any) {
      if (stagedPath) {
        try { await deleteReceiptMutation.mutateAsync({ data: { objectPath: stagedPath } }); }
        catch { /* The upload can be cleaned up later if storage is temporarily unavailable. */ }
      }
      notify('تعذّر الحفظ', error?.message ?? 'حدث خطأ أثناء حفظ المصروف.');
    } finally { setSaving(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <CashHeader title={editId ? 'تعديل المسودة' : 'مصروف جديد'} onBack={() => router.back()} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: Platform.OS === 'web' ? 34 : 28 }}>
        <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 2 }}>
          <View style={{ gap: 4 }}><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 18, fontFamily: 'Inter_700Bold' }}>تفاصيل المصروف</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>المسودة لن تُرحّل حتى اعتمادها</Text></View>
          <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: c.primary + '18', alignItems: 'center', justifyContent: 'center' }}><Feather name="clipboard" size={19} color={c.primary} /></View>
        </View>
        <Card style={{ gap: 15 }}>
          <Field label="تاريخ المصروف" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" ltr testID="cash-expense-date" />
          <SelectRow label="الصندوق النقدي" value={cashBox ? `${cashBox.code} · ${cashBox.name}${cashBox.currencyCode ? ` (${cashBox.currencyCode})` : ''}` : 'اختر الصندوق'} onPress={() => setPicker('cashbox')} />
          <SelectRow label="حساب المصروف" value={account ? `${account.code} · ${account.name}` : 'اختر الحساب'} onPress={() => setPicker('account')} />
          <Field label="المبلغ" value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" ltr testID="cash-expense-amount" />
          <Field label="وصف المصروف" value={description} onChangeText={setDescription} placeholder="ما سبب هذا المصروف؟" multiline testID="cash-expense-description" />
        </Card>
        <Card style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}><SectionLabel>اختياري</SectionLabel><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 15, fontFamily: 'Inter_600SemiBold' }}>إيصال المصروف</Text></View>
          {receipt ? <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 12 }}><Image source={{ uri: receipt.uri }} style={{ width: 64, height: 64, borderRadius: 10, backgroundColor: c.muted }} /><View style={{ flex: 1, gap: 4 }}><Text numberOfLines={1} style={{ color: c.foreground, textAlign: 'right', fontSize: 13 }}>{receipt.fileName ?? 'صورة الإيصال'}</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 11 }}>ستُرفق عند حفظ المسودة</Text></View><Pressable onPress={() => setReceipt(null)} hitSlop={8}><Feather name="x-circle" size={20} color={c.destructive} /></Pressable></View> :
            existing?.receiptAvailable && !removeExistingReceipt ? <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 12, paddingVertical: 7 }}><Feather name="paperclip" size={18} color={c.primary} /><Text style={{ flex: 1, color: c.foreground, textAlign: 'right', fontSize: 13 }}>يوجد إيصال مرفق بهذه المسودة.</Text><Pressable onPress={() => setRemoveExistingReceipt(true)} hitSlop={8}><Text style={{ color: c.destructive, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>إزالة</Text></Pressable></View> :
            removeExistingReceipt ? <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 12, paddingVertical: 7 }}><Feather name="trash-2" size={18} color={c.destructive} /><Text style={{ flex: 1, color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>سيُحذف الإيصال الحالي عند حفظ المسودة.</Text><Pressable onPress={() => setRemoveExistingReceipt(false)} hitSlop={8}><Text style={{ color: c.primary, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>تراجع</Text></Pressable></View> :
            <Pressable onPress={chooseReceipt} testID="cash-expense-receipt" style={({ pressed }) => ({ borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: 12, minHeight: 70, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: pressed ? c.muted : c.background })}><Feather name="image" size={18} color={c.primary} /><Text style={{ color: c.primary, fontSize: 13, fontFamily: 'Inter_600SemiBold' }}>اختيار صورة من الجهاز</Text></Pressable>}
        </Card>
        <View style={{ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 13, flexDirection: 'row-reverse', alignItems: 'center', gap: 9 }}><Feather name="shield" size={16} color={c.primary} /><Text style={{ flex: 1, color: c.mutedForeground, textAlign: 'right', fontSize: 12, lineHeight: 19 }}>سيُسجّل المصروف على {options?.employeeName || 'المستخدم الحالي'} ويظل مسودة حتى ترحيله.</Text></View>
        <Btn title={editId ? 'حفظ التعديلات' : 'حفظ كمسودة'} icon="check" loading={busy} disabled={busy} onPress={save} testID="save-cash-expense" />
      </ScrollView>
      <OptionModal visible={picker !== null} title={picker === 'cashbox' ? 'اختر الصندوق النقدي' : 'اختر حساب المصروف'} rows={picker === 'cashbox' ? options?.cashBoxes ?? [] : options?.expenseAccounts ?? []} onClose={() => setPicker(null)} onSelect={(id) => { if (picker === 'cashbox') setCashBoxId(id); else setAccountId(id); setPicker(null); }} />
    </View>
  );
}

function SelectRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const c = useColors();
  return <View style={{ gap: 6 }}><Text style={{ color: c.mutedForeground, fontSize: 13, textAlign: 'right', fontFamily: 'Inter_500Medium' }}>{label}</Text><Pressable onPress={onPress} style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 12, borderWidth: 1.2, borderColor: c.input, borderRadius: 10, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', backgroundColor: pressed ? c.muted : c.card })}><Feather name="chevron-down" size={16} color={c.mutedForeground} /><Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', color: value.startsWith('اختر') ? c.mutedForeground : c.foreground, fontSize: 14 }}>{value}</Text></Pressable></View>;
}

function OptionModal({ visible, title, rows, onClose, onSelect }: { visible: boolean; title: string; rows: Array<CashExpenseCashBoxOption | CashExpenseAccountOption>; onClose: () => void; onSelect: (id: number) => void }) {
  const c = useColors();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable onPress={onClose} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000055' }}>
      <Pressable onPress={() => {}} style={{ backgroundColor: c.background, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 10, paddingHorizontal: 16, paddingBottom: 30, maxHeight: '78%' }}>
        <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 14 }} />
        <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12 }}><Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={20} color={c.mutedForeground} /></Pressable><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 17, fontFamily: 'Inter_700Bold' }}>{title}</Text></View>
        <ScrollView>{rows.map((row) => <Pressable key={row.id} onPress={() => onSelect(row.id)} style={({ pressed }) => ({ minHeight: 56, borderTopWidth: 1, borderColor: c.border, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, backgroundColor: pressed ? c.muted : 'transparent' })}><Feather name="chevron-left" size={16} color={c.mutedForeground} /><View style={{ flex: 1, gap: 4 }}><Text style={{ color: c.foreground, textAlign: 'right', fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>{row.name}</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 11 }}>{row.code}</Text></View></Pressable>)}</ScrollView>
      </Pressable>
    </Pressable>
  </Modal>;
}

function CashHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return <View style={{ backgroundColor: c.primary, paddingTop: top + 10, paddingHorizontal: 18, paddingBottom: 18, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}><Pressable onPress={onBack} hitSlop={10}><Feather name="arrow-right" size={21} color={c.primaryForeground} /></Pressable><Text style={{ flex: 1, textAlign: 'right', marginHorizontal: 16, color: c.primaryForeground, fontSize: 19, fontFamily: 'Inter_700Bold' }}>{title}</Text><View style={{ width: 22 }} /></View>;
}
function SectionLabel({ children }: { children: React.ReactNode }) { const c = useColors(); return <Text style={{ color: c.mutedForeground, fontSize: 12, textAlign: 'right', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 }}>{children}</Text>; }
function LoadingBlock() { const c = useColors(); return <View style={{ padding: 24, gap: 12 }}>{[0, 1, 2].map((n) => <View key={n} style={{ height: n === 0 ? 82 : 58, borderRadius: 12, backgroundColor: c.muted, opacity: 0.65 }} />)}<ActivityIndicator color={c.primary} style={{ marginTop: 4 }} /></View>; }
