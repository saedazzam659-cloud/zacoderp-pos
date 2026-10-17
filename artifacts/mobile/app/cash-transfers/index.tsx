import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Btn, Card } from '@/components/ui';
import { useCreateCashTransfer, useUploadCashTransferReceipt } from '@workspace/api-client-react';
import { normalizeVoiceFillText, parseVoiceDateValue, subscribeVoiceDocumentFill, subscribeVoiceDocumentCommand } from '@/lib/voiceDocumentFillBus';

type CashBox = { id: number; code: string; nameAr: string; currencyId: number | null };
type Bank = { id: number; code: string; nameAr: string; currencyId: number | null };
type Transfer = {
  id: number; code: string; date: string; transferType: string; amount: string | number;
  status: string; approvalStatus?: string | null; referenceNumber?: string | null;
  description?: string | null; fromCashBoxId?: number | null; toCashBoxId?: number | null;
  toBankId?: number | null; receiptPath?: string | null; createdByUserId?: number | null;
  rejectionReason?: string | null;
};
const today = () => new Date().toISOString().slice(0, 10);
const notify = (title: string, message: string) => Platform.OS === 'web' ? window.alert(`${title}: ${message}`) : Alert.alert(title, message);

export default function CashTransfersScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { mp } = useMobilePerms();
  const qc = useQueryClient();
  const cid = user?.companyId ?? user?.company?.id;
  const [showForm, setShowForm] = useState(false);
  const [destinationType, setDestinationType] = useState<'cash' | 'bank'>('bank');
  const [fromCashBoxId, setFromCashBoxId] = useState<number | null>(null);
  const [toCashBoxId, setToCashBoxId] = useState<number | null>(null);
  const [toBankId, setToBankId] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [picker, setPicker] = useState<'source' | 'cash' | 'bank' | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [receipt, setReceipt] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const transferCreate = useCreateCashTransfer();
  const transferUpload = useUploadCashTransferReceipt();
  const canView = mp('cash_transfers_view_own') || mp('cash_transfers_view_all');
  const canCreate = mp('cash_transfers_create');
  const boxesQ = useQuery({ queryKey: ['mobile-cash-transfer-boxes', cid], enabled: !!cid && (canView || canCreate), queryFn: () => api<CashBox[]>(`/api/cash-boxes?companyId=${cid}`) });
  const banksQ = useQuery({ queryKey: ['mobile-cash-transfer-banks', cid], enabled: !!cid && (canView || canCreate), queryFn: () => api<Bank[]>(`/api/bank-accounts?companyId=${cid}`) });
  const balancesQ = useQuery({ queryKey: ['mobile-cash-transfer-balances', cid], enabled: !!cid && canCreate, queryFn: () => api<Array<{ cashBoxId: number; balance: number }>>(`/api/cash-boxes/balances?companyId=${cid}`) });
  const listQ = useQuery({
    queryKey: ['mobile-cash-transfers', cid],
    enabled: !!cid && canView,
    queryFn: () => api<Transfer[]>(`/api/cash-transfers?companyId=${cid}`),
  });
  const boxes = boxesQ.data ?? [];
  const banks = banksQ.data ?? [];
  const selectedBox = boxes.find((x) => x.id === fromCashBoxId);
  const available = balancesQ.data?.find((x) => x.cashBoxId === fromCashBoxId)?.balance ?? 0;
  const createMutation = useMutation({
    mutationFn: async (submit: boolean) => {
      const value = Number(amount.replace(/,/g, ''));
      if (!fromCashBoxId || !(destinationType === 'cash' ? toCashBoxId : toBankId) || !date || !Number.isFinite(value) || value <= 0) {
        throw new Error('أكمل الصندوق والوجهة والتاريخ والمبلغ.');
      }
      if (value > available) throw new Error(`الرصيد المتاح ${available.toFixed(2)} فقط.`);
      let receiptPath: string | null = null;
      if (receipt?.base64) {
        const mimeType = (receipt.mimeType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
        const uploaded = await transferUpload.mutateAsync({ data: { mimeType, base64: receipt.base64! } });
        receiptPath = uploaded.objectPath;
      }
      const saved = await transferCreate.mutateAsync({ data: {
          companyId: cid, date, transferType: destinationType === 'cash' ? 'cash_to_cash' : 'cash_to_bank',
          fromCashBoxId, toCashBoxId: destinationType === 'cash' ? toCashBoxId : null,
          toBankId: destinationType === 'bank' ? toBankId : null,
          amount: value.toFixed(2), description: notes.trim() || 'إيداع نقدي',
          notes: notes.trim() || null, referenceNumber: referenceNumber.trim() || null, receiptPath,
        } as any });
      if (submit) return api<Transfer>(`/api/cash-transfers/${saved.id}/submit`, { method: 'POST', body: {} });
      return saved;
    },
    onSuccess: async (_data, submit) => {
      await qc.invalidateQueries({ queryKey: ['mobile-cash-transfers', cid] });
      await qc.invalidateQueries({ queryKey: ['mobile-cash-transfer-balances', cid] });
      setShowForm(false); setAmount(''); setReferenceNumber(''); setNotes(''); setReceipt(null);
      notify('تم الحفظ', submit ? 'أُرسل الإيداع للاعتماد.' : 'حُفظ الإيداع كمسودة.');
    },
    onError: (error: any) => notify('تعذّر الحفظ', error?.message ?? 'حاول مرة أخرى.'),
  });
  const actionMutation = useMutation({
    mutationFn: async ({ id, action, reason }: { id: number; action: 'post' | 'reject'; reason?: string }) =>
      api(`/api/cash-transfers/${id}/${action}`, { method: 'POST', body: action === 'reject' ? { reason } : {} }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['mobile-cash-transfers', cid] });
      await qc.invalidateQueries({ queryKey: ['mobile-cash-transfer-balances', cid] });
      setRejectingId(null); setRejectReason('');
      notify('تم تحديث الطلب', 'تم حفظ الإجراء.');
    },
    onError: (error: any) => notify('تعذّر تنفيذ الإجراء', error?.message ?? 'حاول مرة أخرى.'),
  });
  const chooseReceipt = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      const suffix = asset.fileName?.split('.').pop()?.toLowerCase();
      const mimeType = asset.mimeType ?? (suffix === 'png' ? 'image/png' : suffix === 'webp' ? 'image/webp' : suffix === 'jpg' || suffix === 'jpeg' ? 'image/jpeg' : null);
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType ?? '')) {
        notify('صيغة الصورة غير مدعومة', 'اختر صورة بصيغة JPEG أو PNG أو WebP.');
        return;
      }
      setReceipt({ ...asset, mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' });
    }
  };
  const resetForm = () => {
    setShowForm(false); setFromCashBoxId(null); setToCashBoxId(null); setToBankId(null);
    setAmount(''); setReferenceNumber(''); setNotes(''); setReceipt(null); setDate(today());
  };
  const statusLabel = (row: Transfer) => row.approvalStatus === 'pending' ? 'بانتظار الاعتماد'
    : row.approvalStatus === 'rejected' ? 'مرفوض' : row.status === 'posted' ? 'معتمد' : 'مسودة';
  const statusColor = (row: Transfer) => row.approvalStatus === 'pending' ? '#d97706'
    : row.approvalStatus === 'rejected' ? c.destructive : row.status === 'posted' ? c.primary : c.mutedForeground;
  const canSubmit = mp('cash_transfers_submit');
  const canApprove = mp('cash_transfers_approve');
  const canReject = mp('cash_transfers_reject');
  const selectRows = picker === 'source' ? boxes : picker === 'cash' ? boxes : banks;
  const selectTitle = picker === 'source' ? 'اختر صندوق المصدر' : picker === 'cash' ? 'اختر صندوق الوجهة' : 'اختر الحساب البنكي';
  const filteredSelectRows = selectRows
    .filter((x) => picker !== 'cash' || x.id !== fromCashBoxId)
    .filter((x) => normalizeVoiceFillText(`${x.nameAr} ${x.code}`).includes(normalizeVoiceFillText(pickerSearch)));

  React.useEffect(() => subscribeVoiceDocumentFill((transcript) => {
    if (!showForm) return false;
    const text = normalizeVoiceFillText(transcript);
    const dateValue = parseVoiceDateValue(transcript);
    if (dateValue && /(?:التاريخ|تاريخ الايداع)/.test(text)) { setDate(dateValue); return true; }
    const amountValue = text.match(/(?:المبلغ|قيمه الايداع)\s*[:：]?\s*([\d,]+(?:\.\d+)?)/);
    if (amountValue) { setAmount(amountValue[1].replace(/,/g, '')); return true; }
    const reference = text.match(/(?:رقم المرجع|المرجع)\s+(.+)/);
    if (reference) { setReferenceNumber(reference[1]); return true; }
    const notesValue = text.match(/(?:ملاحظات الايداع|الملاحظات|ملاحظات)\s+(.+)/);
    if (notesValue) { setNotes(notesValue[1]); return true; }
    const source = text.match(/(?:الصندوق المصدر|صندوق المصدر|من صندوق)\s+(.+)/);
    if (source) {
      const match = boxes.find((row) => normalizeVoiceFillText(`${row.nameAr} ${row.code}`).includes(source[1]));
      if (match) { setFromCashBoxId(match.id); return true; }
    }
    const targetCash = text.match(/(?:الصندوق المستهدف|الى صندوق|الي صندوق)\s+(.+)/);
    const targetBank = text.match(/(?:الحساب البنكي المستهدف|الى بنك|الي بنك)\s+(.+)/);
    if (targetCash || targetBank) {
      const isCash = !!targetCash;
      const targetName = (targetCash ?? targetBank)![1];
      const candidates = isCash ? boxes.filter((row) => row.id !== fromCashBoxId) : banks;
      const match = candidates.find((row) => normalizeVoiceFillText(`${row.nameAr} ${row.code}`).includes(targetName));
      if (match) {
        if (isCash) { setDestinationType('cash'); setToCashBoxId(match.id); }
        else setToBankId(match.id);
        return true;
      }
    }
    if (/^(?:حول الوجهة الى بنك|وجهه بنك|الى بنك)$/.test(text)) { setDestinationType('bank'); setPicker(null); return true; }
    if (/^(?:حول الوجهة الى صندوق|وجهه صندوق|الى صندوق)$/.test(text)) { setDestinationType('cash'); setPicker(null); return true; }
    return false;
  }), [showForm, boxes, banks, destinationType, fromCashBoxId]);

  React.useEffect(() => subscribeVoiceDocumentCommand((transcript) => {
    const command = normalizeVoiceFillText(transcript);
    if (!showForm && /^(?:افتح|ابدأ|انشئ) (?:نموذج )?ايداع جديد$/.test(command)) {
      if (!canCreate) return false;
      setShowForm(true); return true;
    }
    if (showForm) {
      if (/^(?:من فضلك |لو سمحت )?احفظ الايداع(?: الان)?$/.test(command)) {
        if (!canCreate) return false;
        createMutation.mutate(false); return true;
      }
      if (/^(?:من فضلك |لو سمحت )?(?:ارسل الايداع للاعتماد|اعتمد ارسال الايداع)(?: الان)?$/.test(command)) {
        if (!canCreate || !canSubmit) return false;
        createMutation.mutate(true); return true;
      }
      if (/^(?:الغ|الغي|الغاء) نموذج الايداع$/.test(command)) { resetForm(); return true; }
      return false;
    }
    const approve = command.match(/^(?:اعتمد|وافق على) الايداع(?: رقم)? ([a-z0-9-]+)$/);
    const reject = command.match(/^(?:ارفض) الايداع(?: رقم)? ([a-z0-9-]+)(?: بسبب (.+))$/);
    if (approve) {
      const row = (listQ.data ?? []).find((item) => normalizeVoiceFillText(item.code) === approve[1] || String(item.id) === approve[1]);
      if (!row || !canApprove || row.createdByUserId === user?.id || row.approvalStatus !== 'pending') return false;
      actionMutation.mutate({ id: row.id, action: 'post' }); return true;
    }
    if (reject) {
      const row = (listQ.data ?? []).find((item) => normalizeVoiceFillText(item.code) === reject[1] || String(item.id) === reject[1]);
      if (!row || !canReject || row.createdByUserId === user?.id || row.approvalStatus !== 'pending' || reject[2].trim().length < 3) return false;
      actionMutation.mutate({ id: row.id, action: 'reject', reason: reject[2].trim() }); return true;
    }
    return false;
  }), [showForm, canCreate, canSubmit, canApprove, canReject, createMutation, actionMutation, listQ.data, user?.id]);

  return <View style={{ flex: 1, backgroundColor: c.background }}>
    <View style={{ backgroundColor: c.primary, paddingTop: (Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top) + 10, paddingBottom: 16, paddingHorizontal: 16, flexDirection: 'row-reverse', alignItems: 'center', gap: 12 }}>
      <Pressable onPress={() => router.back()} hitSlop={10}><Feather name="arrow-right" size={20} color={c.primaryForeground} /></Pressable>
      <Text style={{ flex: 1, color: c.primaryForeground, textAlign: 'right', fontSize: 19, fontFamily: 'Inter_700Bold' }}>إيداعات الصناديق</Text>
      {canCreate && !showForm ? <Pressable onPress={() => setShowForm(true)} testID="new-cash-transfer" hitSlop={8}><Feather name="plus" size={22} color={c.primaryForeground} /></Pressable> : <View style={{ width: 22 }} />}
    </View>
    {!canView && !canCreate ? <View style={{ padding: 16 }}><Card><Text style={{ color: c.mutedForeground, textAlign: 'right' }}>لا تملك صلاحية الوصول إلى إيداعات الصناديق.</Text></Card></View> :
      showForm ? <KeyboardAwareScrollViewCompat keyboardShouldPersistTaps="handled" bottomOffset={70} contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 24 }}>
        <Card style={{ gap: 12 }}>
          <Text style={{ color: c.foreground, textAlign: 'right', fontSize: 16, fontFamily: 'Inter_700Bold' }}>إيداع نقدي جديد</Text>
          <Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>الرصيد المتاح: {available.toFixed(2)} {selectedBox?.nameAr ?? ''}</Text>
          <Select label="الصندوق المصدر" value={selectedBox?.nameAr ?? ''} onPress={() => { setPicker(picker === 'source' ? null : 'source'); setPickerSearch(''); }} />
          <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
            <Choice label="إلى بنك" selected={destinationType === 'bank'} onPress={() => { setDestinationType('bank'); setPicker(null); setPickerSearch(''); }} />
            <Choice label="إلى صندوق" selected={destinationType === 'cash'} onPress={() => { setDestinationType('cash'); setPicker(null); setPickerSearch(''); }} />
          </View>
          <Select label={destinationType === 'cash' ? 'الصندوق المستهدف' : 'الحساب البنكي المستهدف'}
            value={destinationType === 'cash' ? boxes.find((x) => x.id === toCashBoxId)?.nameAr ?? '' : banks.find((x) => x.id === toBankId)?.nameAr ?? ''}
            onPress={() => { setPicker(picker === (destinationType === 'cash' ? 'cash' : 'bank') ? null : destinationType === 'cash' ? 'cash' : 'bank'); setPickerSearch(''); }} />
          {picker ? <Card style={{ gap: 2, backgroundColor: c.muted }}>
            <Text style={{ color: c.foreground, textAlign: 'right', fontFamily: 'Inter_600SemiBold', paddingVertical: 7 }}>{selectTitle}</Text>
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 9 }}>
              <Feather name="search" size={15} color={c.mutedForeground} />
              <TextInput value={pickerSearch} onChangeText={setPickerSearch} placeholder="بحث بالاسم أو الكود" placeholderTextColor={c.mutedForeground} testID="cash-transfer-option-search" style={{ flex: 1, minHeight: 42, paddingHorizontal: 8, color: c.foreground, textAlign: 'right' }} />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
              {filteredSelectRows.map((row: any) => <Pressable key={row.id} onPress={() => {
                if (picker === 'source') setFromCashBoxId(row.id);
                else if (picker === 'cash') setToCashBoxId(row.id);
                else setToBankId(row.id);
                setPicker(null); setPickerSearch('');
              }} style={{ paddingVertical: 10, borderTopWidth: 1, borderColor: c.border, flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.foreground, textAlign: 'right' }}>{row.nameAr}</Text><Text style={{ color: c.mutedForeground }}>{row.code}</Text>
              </Pressable>)}
            </ScrollView>
            {!filteredSelectRows.length ? <Text style={{ color: c.mutedForeground, textAlign: 'right', paddingVertical: 8 }}>لا توجد نتائج</Text> : null}
          </Card> : null}
          <Input label="التاريخ" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
          <Input label="المبلغ" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
          <Input label="رقم المرجع" value={referenceNumber} onChangeText={setReferenceNumber} placeholder="اختياري" />
          <Input label="الملاحظات" value={notes} onChangeText={setNotes} multiline placeholder="ملاحظات الإيداع" />
          <Pressable onPress={chooseReceipt} style={{ padding: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: 11, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Feather name="paperclip" size={17} color={c.primary} /><Text style={{ color: c.primary, fontFamily: 'Inter_600SemiBold' }}>{receipt ? receipt.fileName ?? 'تم اختيار الإيصال' : 'إرفاق صورة إيصال'}</Text>
          </Pressable>
          {receipt?.uri ? <Image source={{ uri: receipt.uri }} style={{ height: 130, borderRadius: 10 }} resizeMode="contain" /> : null}
          <Btn title="حفظ كمسودة" icon="save" disabled={createMutation.isPending} loading={createMutation.isPending} onPress={() => createMutation.mutate(false)} />
          {canSubmit ? <Btn title="إرسال للاعتماد" icon="send" kind="outline" disabled={createMutation.isPending} onPress={() => createMutation.mutate(true)} /> : null}
          <Pressable onPress={resetForm} style={{ paddingVertical: 10 }}><Text style={{ color: c.mutedForeground, textAlign: 'center' }}>إلغاء</Text></Pressable>
        </Card>
      </KeyboardAwareScrollViewCompat> :
      !canView ? <View style={{ padding: 16 }}><Card><Text style={{ color: c.mutedForeground, textAlign: 'right' }}>يمكنك إنشاء إيداع جديد، لكن لا تملك صلاحية عرض السجل.</Text></Card></View> :
      listQ.isLoading ? <ActivityIndicator color={c.primary} style={{ marginTop: 30 }} /> :
      listQ.isError ? <Card style={{ margin: 16 }}><Text style={{ color: c.destructive, textAlign: 'right' }}>تعذّر تحميل سجل الإيداعات.</Text><Btn title="إعادة المحاولة" icon="refresh-cw" kind="outline" onPress={() => listQ.refetch()} /></Card> :
      <FlatList data={listQ.data ?? []} keyExtractor={(x) => String(x.id)}
        refreshControl={<RefreshControl refreshing={listQ.isRefetching} onRefresh={() => listQ.refetch()} tintColor={c.primary} />}
        contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 20, flexGrow: 1 }}
        ListEmptyComponent={<Card><Text style={{ color: c.mutedForeground, textAlign: 'right' }}>لا توجد إيداعات مسجلة.</Text></Card>}
        renderItem={({ item }) => <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', gap: 10 }}>
            <View style={{ flex: 1, gap: 4 }}><Text style={{ color: c.foreground, textAlign: 'right', fontFamily: 'Inter_700Bold' }}>{item.code} · {item.date}</Text><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{item.referenceNumber || item.description || '—'}</Text></View>
            <Text style={{ color: statusColor(item), fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>{statusLabel(item)}</Text>
          </View>
          <Text style={{ color: c.primary, textAlign: 'right', fontSize: 19, fontFamily: 'Inter_700Bold' }}>{Number(item.amount).toFixed(2)}</Text>
          {item.approvalStatus === 'rejected' && item.rejectionReason ? <Text style={{ color: c.destructive, textAlign: 'right', fontSize: 12 }}>{item.rejectionReason}</Text> : null}
          {item.approvalStatus === 'pending' && item.createdByUserId !== user?.id && (canApprove || canReject) ? <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
            {canApprove ? <View style={{ flex: 1 }}><Btn title="اعتماد" icon="check" disabled={actionMutation.isPending} onPress={() => actionMutation.mutate({ id: item.id, action: 'post' })} /></View> : null}
            {canReject ? <View style={{ flex: 1 }}><Btn title="رفض" icon="x" kind="outline" disabled={actionMutation.isPending} onPress={() => { setRejectingId(rejectingId === item.id ? null : item.id); setRejectReason(''); }} /></View> : null}
          </View> : null}
          {rejectingId === item.id ? <View style={{ gap: 8 }}>
            <Input label="سبب الرفض" value={rejectReason} onChangeText={setRejectReason} placeholder="اكتب سبباً واضحاً" />
            <Btn title="تأكيد الرفض" icon="x" kind="outline" disabled={actionMutation.isPending || rejectReason.trim().length < 3} onPress={() => actionMutation.mutate({ id: item.id, action: 'reject', reason: rejectReason.trim() })} />
          </View> : null}
        </Card>}
      />
    }
  </View>;
}

function Input({ label, value, onChangeText, ...props }: any) {
  const c = useColors();
  return <View style={{ gap: 5 }}><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholderTextColor={c.mutedForeground} style={{ minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, color: c.foreground, textAlign: props.keyboardType === 'decimal-pad' ? 'left' : 'right', backgroundColor: c.background }} {...props} /></View>;
}
function Select({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const c = useColors();
  return <View style={{ gap: 5 }}><Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{label}</Text><Pressable onPress={onPress} style={{ minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}><Feather name="chevron-down" size={16} color={c.mutedForeground} /><Text style={{ color: value ? c.foreground : c.mutedForeground, textAlign: 'right' }}>{value || 'اختر'}</Text></Pressable></View>;
}
function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return <Pressable onPress={onPress} style={{ flex: 1, padding: 11, borderRadius: 10, alignItems: 'center', backgroundColor: selected ? c.primary : c.background, borderWidth: 1, borderColor: selected ? c.primary : c.border }}><Text style={{ color: selected ? c.primaryForeground : c.foreground, fontFamily: 'Inter_600SemiBold' }}>{label}</Text></Pressable>;
}
