import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, ErrorBox } from '@/components/ui';
import { getDomain, getToken } from '@/lib/api';
import { useGetCashExpense, usePostCashExpense, useCancelCashExpense, getGetCashExpenseQueryKey, getGetCashExpensesQueryKey, getGetCashExpenseReportQueryKey } from '@workspace/api-client-react';
import type { CashExpense } from '@workspace/api-client-react';
import { normalizeVoiceFillText, subscribeVoiceDocumentCommand } from '@/lib/voiceDocumentFillBus';

function notify(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}: ${text}`);
  else Alert.alert(title, text);
}

export default function CashExpenseDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = Number(rawId) || 0;
  const { mp } = useMobilePerms();
  const canView = mp('cash_expenses_view_own') || mp('cash_expenses_view_all');
  return <DetailBody id={id} allowed={canView} />;
}

function DetailBody({ id, allowed }: { id: number; allowed: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const c = useColors();
  const { mp } = useMobilePerms();
  const qc = useQueryClient();
  const detail = useGetCashExpense(id, { query: { queryKey: getGetCashExpenseQueryKey(id), enabled: allowed && !!id } });
  const postMutation = usePostCashExpense();
  const cancelMutation = useCancelCashExpense();
  const [working, setWorking] = useState(false);
  const [receiptSource, setReceiptSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [receiptImageError, setReceiptImageError] = useState(false);
  const expense = detail.data as CashExpense | undefined;
  const canEdit = mp('cash_expenses_edit');
  const canPost = mp('cash_expenses_post');
  const canCancel = mp('cash_expenses_cancel');

  React.useEffect(() => {
    let active = true;
    setReceiptSource(null);
    setReceiptImageError(false);
    if (!expense?.receiptAvailable) return () => { active = false; };
    void Promise.all([getDomain(), getToken()]).then(([domain, token]) => {
      if (!active) return;
      if (!token) { setReceiptImageError(true); return; }
      setReceiptSource({
        uri: `https://${domain}/api/cash-expenses/${id}/receipt`,
        headers: { Authorization: `Bearer ${token}`, 'x-app-channel': 'mobile' },
      });
    }).catch(() => { if (active) setReceiptImageError(true); });
    return () => { active = false; };
  }, [expense?.receiptAvailable, id]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getGetCashExpenseQueryKey(id) }),
      qc.invalidateQueries({ queryKey: getGetCashExpensesQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetCashExpenseReportQueryKey() }),
    ]);
  };
  const perform = async (action: 'post' | 'cancel') => {
    setWorking(true);
    try {
      if (action === 'post') await postMutation.mutateAsync({ id });
      else await cancelMutation.mutateAsync({ id });
      await refresh();
      notify('تم', action === 'post' ? 'تم ترحيل المصروف وإنشاء قيده.' : 'تم إلغاء المصروف.');
    } catch (error: any) { notify('تعذّر تنفيذ الإجراء', error?.message ?? 'حدث خطأ، حاول مرة أخرى.'); }
    finally { setWorking(false); }
  };
  const confirmAction = (action: 'post' | 'cancel') => {
    const title = action === 'post' ? 'ترحيل المصروف' : 'إلغاء المصروف';
    const message = action === 'post' ? 'سيُسجّل المصروف نهائياً على الصندوق النقدي. هل تريد المتابعة؟' : 'سيتم إلغاء هذا المصروف. هل تريد المتابعة؟';
    if (Platform.OS === 'web') { if (window.confirm(`${title}\n${message}`)) void perform(action); return; }
    Alert.alert(title, message, [{ text: 'رجوع', style: 'cancel' }, { text: action === 'post' ? 'ترحيل' : 'إلغاء المصروف', style: action === 'cancel' ? 'destructive' : 'default', onPress: () => void perform(action) }]);
  };

  React.useEffect(() => subscribeVoiceDocumentCommand((transcript) => {
    if (!allowed || !expense || pathname !== `/cash-expenses/${id}`) return false;
    const command = normalizeVoiceFillText(transcript);
    if (/^(?:من فضلك |لو سمحت )?رحل المصروف(?: الان)?$/.test(command)) {
      if (!canPost || expense?.status !== 'draft') return false;
      void perform('post');
      return true;
    }
    if (/^(?:من فضلك |لو سمحت )?(?:الغ|الغي|الغاء) المصروف(?: الان)?$/.test(command)) {
      if (!canCancel || expense?.status === 'cancelled') return false;
      void perform('cancel');
      return true;
    }
    return false;
  }), [pathname, id, canPost, canCancel, expense?.status, perform]);

  if (!allowed) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="تفاصيل المصروف" onBack={() => router.back()} /><View style={{ padding: 18 }}><Card><Text style={{ color: c.mutedForeground, textAlign: 'right', lineHeight: 22 }}>لا تملك صلاحية عرض المصروفات النقدية.</Text></Card></View></View>;
  if (detail.isLoading) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="تفاصيل المصروف" onBack={() => router.back()} /><LoadingBlock /></View>;
  if (detail.isError || !expense) return <View style={{ flex: 1, backgroundColor: c.background }}><CashHeader title="تفاصيل المصروف" onBack={() => router.back()} /><ErrorBox text={(detail.error as Error)?.message ?? 'لم يتم العثور على المصروف'} onRetry={() => detail.refetch()} /></View>;

  const draft = expense.status === 'draft';
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <CashHeader title={expense.code || 'تفاصيل المصروف'} onBack={() => router.back()} right={draft && canEdit ? <Pressable onPress={() => router.push({ pathname: '/cash-expenses/new', params: { editId: String(id) } })} hitSlop={8} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.primaryForeground + '20', alignItems: 'center', justifyContent: 'center' }}><Feather name="edit-2" size={17} color={c.primaryForeground} /></Pressable> : undefined} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 13, paddingBottom: Platform.OS === 'web' ? 34 : 24 }}>
        <Card style={{ backgroundColor: c.primary, borderColor: c.primary, gap: 13 }}>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ color: c.primaryForeground, fontSize: 16, fontFamily: 'Inter_700Bold' }}>{expense.code}</Text><StatusPill status={expense.status} /></View>
          <Text style={{ color: c.primaryForeground, fontSize: 13, textAlign: 'right', lineHeight: 20 }}>{expense.description}</Text>
          <View style={{ borderTopWidth: 1, borderColor: c.primaryForeground + '35', paddingTop: 10, flexDirection: 'row-reverse', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <Text style={{ color: c.primaryForeground + 'C8', fontSize: 12 }}>المبلغ</Text>
            <Text style={{ color: c.primaryForeground, fontSize: 28, fontFamily: 'Inter_700Bold', writingDirection: 'ltr' }}>{Number(expense.amount).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{expense.currencyCode ? ` ${expense.currencyCode}` : ''}</Text>
          </View>
        </Card>
        <Card style={{ gap: 0 }}>
          <DetailRow label="تاريخ المصروف" value={String(expense.date).slice(0, 10)} />
          <DetailRow label="الصندوق النقدي" value={expense.cashBoxName} />
          <DetailRow label="حساب المصروف" value={expense.expenseAccountName} />
          <DetailRow label="العملة" value={expense.currencyCode || 'غير محددة'} />
          <DetailRow label="الموظف" value={expense.employeeName || '—'} />
          {expense.salesRepName ? <DetailRow label="مندوب المبيعات" value={expense.salesRepName} /> : null}
          <DetailRow label="تاريخ التسجيل" value={String(expense.createdAt).slice(0, 10)} />
          <DetailRow label="الإيصال" value={expense.receiptAvailable ? 'مرفق' : 'غير مرفق'} last />
        </Card>
        {expense.receiptAvailable ? <Card style={{ gap: 10 }}>
          <Text style={{ color: c.foreground, textAlign: 'right', fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>صورة الإيصال</Text>
          {receiptSource && !receiptImageError
            ? <Image source={receiptSource} onError={() => setReceiptImageError(true)} resizeMode="contain" accessibilityLabel="صورة إيصال المصروف" style={{ width: '100%', height: 250, borderRadius: 10, backgroundColor: c.muted }} />
            : <Text style={{ color: c.mutedForeground, textAlign: 'right', fontSize: 12 }}>{receiptImageError ? 'تعذّر تحميل صورة الإيصال.' : 'جارٍ تحميل صورة الإيصال...'}</Text>}
        </Card> : null}
        {expense.journalEntryId ? <Card style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}><SectionLabel>قيد اليومية</SectionLabel><Text style={{ color: c.primary, fontFamily: 'Inter_600SemiBold' }}>#{expense.journalEntryId}</Text></Card> : null}
        {expense.status === 'cancelled' && expense.cancelledAt ? <Card style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}><SectionLabel>تاريخ الإلغاء</SectionLabel><Text style={{ color: c.destructive, fontSize: 12 }}>{String(expense.cancelledAt).slice(0, 10)}</Text></Card> : null}
        {draft && canEdit ? <Btn title="تعديل المسودة" icon="edit-2" kind="outline" onPress={() => router.push({ pathname: '/cash-expenses/new', params: { editId: String(id) } })} /> : null}
        {draft && canPost ? <Btn title="ترحيل المصروف" icon="check-circle" loading={working && postMutation.isPending} disabled={working} onPress={() => confirmAction('post')} testID="post-cash-expense" /> : null}
        {expense.status !== 'cancelled' && canCancel ? <Btn title="إلغاء المصروف" icon="slash" kind="destructive" loading={working && cancelMutation.isPending} disabled={working} onPress={() => confirmAction('cancel')} testID="cancel-cash-expense" /> : null}
      </ScrollView>
    </View>
  );
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const c = useColors();
  return <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderColor: c.border, gap: 12 }}><Text numberOfLines={1} style={{ flex: 1, color: c.foreground, textAlign: 'right', fontSize: 13, fontFamily: 'Inter_500Medium' }}>{value}</Text><SectionLabel>{label}</SectionLabel></View>;
}

function CashHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return <View style={{ backgroundColor: c.primary, paddingTop: top + 10, paddingHorizontal: 18, paddingBottom: 18, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}><Pressable onPress={onBack} hitSlop={10}><Feather name="arrow-right" size={21} color={c.primaryForeground} /></Pressable><Text style={{ flex: 1, textAlign: 'right', marginHorizontal: 16, color: c.primaryForeground, fontSize: 19, fontFamily: 'Inter_700Bold' }}>{title}</Text>{right ?? <View style={{ width: 22 }} />}</View>;
}
function SectionLabel({ children }: { children: React.ReactNode }) { const c = useColors(); return <Text style={{ color: c.mutedForeground, fontSize: 12, textAlign: 'right', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 }}>{children}</Text>; }
function StatusPill({ status }: { status: string }) {
  const c = useColors();
  const tint = status === 'posted' ? c.primary : status === 'cancelled' ? c.destructive : c.mutedForeground;
  const label = status === 'posted' ? 'مرحّل' : status === 'cancelled' ? 'ملغي' : 'مسودة';
  return <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 5, backgroundColor: tint + '18', borderRadius: 20, paddingVertical: 5, paddingHorizontal: 9 }}><View style={{ width: 6, height: 6, borderRadius: 4, backgroundColor: tint }} /><Text style={{ color: tint, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>{label}</Text></View>;
}
function LoadingBlock() { const c = useColors(); return <View style={{ padding: 24, gap: 12 }}>{[0, 1, 2].map((n) => <View key={n} style={{ height: n === 0 ? 82 : 58, borderRadius: 12, backgroundColor: c.muted, opacity: 0.65 }} />)}<ActivityIndicator color={c.primary} style={{ marginTop: 4 }} /></View>; }
