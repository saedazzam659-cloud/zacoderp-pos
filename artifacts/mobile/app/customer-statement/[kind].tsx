import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { api } from '@/lib/api';
import { todayISO, money } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, ErrorBox, Field } from '@/components/ui';
import { renderStatementHtml, type StatementCompany, type StatementLine } from '@/lib/statementHtml';
import { statementBalances, statementExclusion } from '@/lib/statementLedger';

type Customer = { id: number; accountId?: number | null; nameAr: string; nameEn?: string | null };
type LedgerRow = {
  id: number | null; date: string; type: string; docNumber: string | null;
  journalEntryId?: number | null; journalEntryNumber?: string | null;
  debit: number; credit: number; description: string;
  paymentType?: string | null; channel?: string | null;
  lines?: { itemCode?: string | null; itemName: string; qty: number; unit?: string | null;
    unitPrice: number; discount: number; vatAmount: number; vatRate: number; lineTotal: number }[];
  meta?: { paymentType?: string | null; cashBoxName?: string | null; bankAccountName?: string | null; refNumber?: string | null; description?: string | null };
};
type Ledger = {
  opening: number;
  lines: LedgerRow[];
  account?: { code?: string | null; nameAr?: string | null; nameEn?: string | null; level?: number | string | null } | null;
  excluded?: boolean;
  reason?: string;
  message?: string;
};
type Filter = { customerId: number | null; from: string; to: string; branchId: number | null; withOpening: boolean };
type Branch = { id: number; nameAr?: string; nameEn?: string };
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const labels: Record<string, string> = {
  invoice: 'فاتورة مبيعات', invoice_receipt: 'تحصيل فاتورة', return: 'مرتجع مبيعات',
  return_refund: 'رد مرتجع', receipt: 'سند قبض', journal: 'قيد يومية',
};
const number = (n: number) => Number(n || 0);
function docLabel(row: LedgerRow) {
  const base = labels[row.type] ?? row.type;
  if (row.type === 'invoice' || row.type === 'return')
    return `${base} - ${row.paymentType === 'cash' ? 'نقدًا' : row.paymentType === 'bank' ? 'بنكيًا' : 'أجل'}`;
  if (['receipt', 'invoice_receipt', 'return_refund'].includes(row.type))
    return `${base}${row.channel === 'cashbox' ? ' - نقدي' : row.channel === 'bank' ? ' - بنكي' : ''}`;
  return base;
}
function detailText(row: LedgerRow): string[] {
  if ((row.type === 'invoice' || row.type === 'return') && row.lines?.length)
    return row.lines.map(l => `• ${l.itemCode ? `[${l.itemCode}] ` : ''}${l.itemName} — الكمية: ${money(l.qty)} ${l.unit ?? ''} × ${money(l.unitPrice)}${l.discount ? `، الخصم: ${money(l.discount)}` : ''}، الضريبة: ${money(l.vatAmount)} (${money(l.vatRate)}%)، الإجمالي: ${money(l.lineTotal)}`);
  if (row.type === 'receipt' && row.meta) {
    const m = row.meta;
    const parts = [m.paymentType && `نوع الدفع: ${m.paymentType}`, m.cashBoxName && `الصندوق: ${m.cashBoxName}`, m.bankAccountName && `البنك: ${m.bankAccountName}`, m.refNumber && `المرجع: ${m.refNumber}`, m.description && `الشرح: ${m.description}`].filter(Boolean);
    return parts.length ? [`• ${parts.join(' | ')}`] : [];
  }
  return [];
}

export default function CustomerStatementScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const detailed = kind === 'detailed';
  const valid = kind === 'ordinary' || detailed;
  const perm = detailed ? 'customer_statement_detailed_view' : 'customer_statement_view';
  const { mp } = useMobilePerms();
  const { user, companyId } = useAuth();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const now = new Date();
  const [draft, setDraft] = useState<Filter>({
    customerId: null, from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
    to: todayISO(), branchId: null, withOpening: true,
  });
  const [applied, setApplied] = useState<Filter | null>(null);
  const [showCustomers, setShowCustomers] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [printing, setPrinting] = useState(false);
  const allowed = valid && mp(perm);
  const customers = useQuery({
    queryKey: ['statement-customers', companyId],
    queryFn: () => api<Customer[]>(`/api/customers?companyId=${companyId}`),
    enabled: !!companyId && allowed,
  });
  const branches = useQuery({
    queryKey: ['statement-branches', companyId],
    queryFn: () => api<Branch[]>(`/api/org/branches?companyId=${companyId}&onlyUserBranches=1`),
    enabled: !!companyId && allowed,
  });
  const customer = (customers.data ?? []).find(x => x.id === draft.customerId);
  const selectedCustomer = (customers.data ?? []).find(x => x.id === applied?.customerId);
  const statement = useQuery({
    queryKey: ['customer-statement', kind, companyId, applied],
    queryFn: () => api<Ledger>(
      `/api/sales-analytics/customer-statement${detailed ? '-detailed' : ''}?companyId=${companyId}&customerId=${applied!.customerId}&from=${encodeURIComponent(applied!.from)}&to=${encodeURIComponent(applied!.to)}${applied!.branchId ? `&branchId=${applied!.branchId}` : ''}`
    ),
    enabled: allowed && !!companyId && !!applied?.customerId,
  });
  const ledger = useMemo(() => {
    const opening = detailed || applied?.withOpening ? number(statement.data?.opening ?? 0) : 0;
    const balances = statementBalances(opening, statement.data?.lines ?? []);
    const lines: StatementLine[] = [];
    for (const [i, l] of (statement.data?.lines ?? []).entries()) {
      const balance = balances[i];
      lines.push({ ...l, date: l.date, docType: docLabel(l), balance, type: labels[l.type] ?? l.type });
      if (detailed) for (const text of detailText(l))
        lines.push({ detail: true, date: '', docType: '', docNumber: '', type: '', description: text, debit: 0, credit: 0, balance });
    }
    const totals = (statement.data?.lines ?? []).reduce((acc, l) => ({
      debit: acc.debit + number(l.debit), credit: acc.credit + number(l.credit),
    }), { debit: 0, credit: 0 });
    return { opening, lines, balances, totals, closing: opening + totals.debit - totals.credit };
  }, [statement.data, detailed, applied?.withOpening]);
  const exclusion = statementExclusion(statement.data);
  const missingAccount = !!statement.data && !exclusion && !!selectedCustomer?.accountId && !statement.data.account;
  const accountNotice = 'تعذّر تجهيز طباعة كشف الحساب: الخادم لا يرسل بيانات حساب العميل. يرجى تحديث الخادم ثم إعادة عرض الكشف.';
  const branchName = (branches.data ?? []).find(b => b.id === applied?.branchId);
  const html = () => renderStatementHtml({
    mode: 'customer', company: (user?.company as StatementCompany | undefined) ?? null,
    account: { code: statement.data?.account?.code, level: statement.data?.account?.level,
      nameAr: statement.data?.account?.nameAr, nameEn: statement.data?.account?.nameEn,
      partyNameAr: selectedCustomer?.nameAr, partyNameEn: selectedCustomer?.nameEn },
    from: applied!.from, to: applied!.to, opening: ledger.opening,
    lines: ledger.lines, totals: ledger.totals, closing: ledger.closing,
    branchName: branchName?.nameAr ?? branchName?.nameEn,
    userName: user?.username,
    filename: `${detailed ? 'كشف-حساب-عميل-تفصيلي' : 'كشف-حساب-عميل'}-${selectedCustomer?.nameAr ?? ''}-${applied!.from}-${applied!.to}`,
  });
  const output = async (share: boolean) => {
    if (!applied || !statement.data || exclusion || printing) return;
    if (missingAccount) { Alert.alert('يلزم تحديث الخادم', accountNotice); return; }
    setPrinting(true);
    try {
      if (share) {
        const { uri } = await Print.printToFileAsync({ html: html() });
        if (Platform.OS === 'web') { window.open(uri, '_blank'); return; }
        if (!await Sharing.isAvailableAsync()) throw new Error('مشاركة الملفات غير متاحة على هذا الجهاز');
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'مشاركة كشف حساب العميل' });
      } else await Print.printAsync({ html: html() });
    } catch (err) {
      Alert.alert('تعذّر إنشاء الكشف', err instanceof Error ? err.message : String(err));
    } finally { setPrinting(false); }
  };
  const row = (label: string, value: string) => (
    <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={{ color: c.mutedForeground, textAlign: 'right', flex: 1 }}>{label}</Text>
      <Text style={{ color: c.foreground, fontFamily: 'Inter_600SemiBold' }}>{value}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: (Platform.OS === 'web' ? 67 : insets.top) + 10, paddingBottom: 16, paddingHorizontal: 16, flexDirection: 'row-reverse', gap: 16 }}>
        <Pressable onPress={() => router.back()}><Feather name="arrow-right" size={23} color={c.primaryForeground} /></Pressable>
        <Text style={{ color: c.primaryForeground, fontSize: 18, fontFamily: 'Inter_700Bold' }}>{detailed ? 'كشف حساب عميل تفصيلي' : 'كشف حساب عميل'}</Text>
      </View>
      {!allowed ? <Card style={{ margin: 16 }}><Text style={{ color: c.mutedForeground, textAlign: 'right' }}>لا تملك صلاحية عرض كشف الحساب.</Text></Card> :
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 36, gap: 12 }}>
        <Card style={{ gap: 12 }}>
          <Field label="بحث عن عميل" value={search} onChangeText={v => { setSearch(v); setShowCustomers(true); }} placeholder="الاسم أو الرقم" />
          <Pressable onPress={() => setShowCustomers(!showCustomers)} style={{ padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
            <Text style={{ color: c.foreground, textAlign: 'right' }}>{customer ? `${customer.nameAr} ${customer.nameEn ?? ''}` : 'اختر عميلاً'}</Text>
          </Pressable>
          {showCustomers && (customers.isLoading ? <ActivityIndicator color={c.primary} /> : customers.isError ?
            <ErrorBox text={(customers.error as Error).message} onRetry={() => customers.refetch()} /> :
            <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }}>
              {(customers.data ?? []).filter(x => `${x.nameAr} ${x.nameEn ?? ''} ${x.id}`.toLowerCase().includes(search.toLowerCase())).map(x =>
                <Pressable key={x.id} onPress={() => { setDraft(p => ({ ...p, customerId: x.id })); setShowCustomers(false); setSearch(''); }} style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
                  <Text style={{ color: c.foreground, textAlign: 'right' }}>{x.nameAr} {x.nameEn ?? ''}</Text>
                </Pressable>)}
            </ScrollView>)}
          <Field label="من تاريخ (YYYY-MM-DD)" value={draft.from} onChangeText={from => setDraft(p => ({ ...p, from }))} ltr />
          <Field label="إلى تاريخ (YYYY-MM-DD)" value={draft.to} onChangeText={to => setDraft(p => ({ ...p, to }))} ltr />
          <Pressable onPress={() => setShowBranches(!showBranches)}><Text style={{ textAlign: 'right', color: c.primary }}>الفرع: {draft.branchId ? (branches.data ?? []).find(b => b.id === draft.branchId)?.nameAr ?? '—' : 'جميع الفروع'} ▾</Text></Pressable>
          {showBranches && <View>
            <Pressable onPress={() => { setDraft(p => ({ ...p, branchId: null })); setShowBranches(false); }}><Text style={{ color: c.foreground, padding: 8, textAlign: 'right' }}>جميع الفروع</Text></Pressable>
            {branches.isError ? <ErrorBox text={(branches.error as Error).message} onRetry={() => branches.refetch()} /> : (branches.data ?? []).map(b =>
              <Pressable key={b.id} onPress={() => { setDraft(p => ({ ...p, branchId: b.id })); setShowBranches(false); }}><Text style={{ color: c.foreground, padding: 8, textAlign: 'right' }}>{b.nameAr ?? b.nameEn}</Text></Pressable>)}
          </View>}
          {!detailed && <Pressable onPress={() => setDraft(p => ({ ...p, withOpening: !p.withOpening }))}><Text style={{ textAlign: 'right', color: c.foreground }}>{draft.withOpening ? '☑' : '□'} إظهار الرصيد الافتتاحي</Text></Pressable>}
          <Btn title="عرض الكشف" icon="search" onPress={() => {
            if (!draft.customerId) { Alert.alert('اختر عميلاً أولاً'); return; }
            if (!validDate(draft.from) || !validDate(draft.to) || draft.from > draft.to) { Alert.alert('أدخل فترة زمنية صحيحة'); return; }
            setApplied({ ...draft });
          }} />
        </Card>
        {applied && (statement.isLoading ? <ActivityIndicator color={c.primary} size="large" /> : statement.isError ?
          <ErrorBox text={(statement.error as Error).message} onRetry={() => statement.refetch()} /> : exclusion ?
          <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>{exclusion}</Text></Card> : statement.data && <>
            <Card>{row('الرصيد الافتتاحي', money(ledger.opening))}{row('إجمالي المدين', money(ledger.totals.debit))}{row('إجمالي الدائن', money(ledger.totals.credit))}{row('الرصيد الختامي', money(ledger.closing))}</Card>
            {missingAccount && <Card><Text style={{ color: c.destructive, textAlign: 'right' }}>{accountNotice}</Text></Card>}
            <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
              <View style={{ flex: 1 }}><Btn title="طباعة" icon="printer" disabled={printing} onPress={() => output(false)} /></View>
              <View style={{ flex: 1 }}><Btn title="PDF / مشاركة" icon="share-2" disabled={printing} onPress={() => output(true)} /></View>
            </View>
            {statement.data.lines.length === 0 ? <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا توجد حركات في الفترة المحددة</Text></Card> :
              statement.data.lines.map((l, i) => {
                const bal = ledger.balances[i];
                return <Card key={`${l.type}-${l.id}-${i}`} style={{ gap: 4 }}>
                  <Text style={{ textAlign: 'right', color: c.primary, fontFamily: 'Inter_700Bold' }}>{docLabel(l)} · {l.docNumber ?? (l.id != null ? `#${l.id}` : '—')}</Text>
                  <Text style={{ textAlign: 'right', color: c.mutedForeground }}>{l.date} · {l.description}</Text>
                  {row('مدين', money(number(l.debit)))}{row('دائن', money(number(l.credit)))}{row('الرصيد', money(bal ?? 0))}
                  {detailed && detailText(l).map((text, idx) => <Text key={idx} style={{ color: c.mutedForeground, textAlign: 'right' }}>{text}</Text>)}
                </Card>;
              })}
          </>)}
      </ScrollView>}
    </View>
  );
}