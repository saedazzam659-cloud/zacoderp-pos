import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, qty as fq, todayISO, showDate } from '@/lib/format';
import { onScan, clearScan } from '@/lib/scanBus';
import { printInvoice, shareInvoicePdf } from '@/lib/print';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Chip, Empty, Field } from '@/components/ui';

interface Item {
  id: number;
  code?: string;
  nameAr?: string;
  barcode?: string | null;
  salePrice?: number | string;
  vatRate?: number | string;
  group?: { id?: number; nameAr?: string } | null;
  unit?: { id?: number; nameAr?: string } | null;
}

interface CartLine {
  itemId: number;
  name: string;
  qty: number;
  unitPrice: number;
  vatRate: number;
}

const TABS = [
  { key: 'basic', label: 'بيانات أساسية' },
  { key: 'items', label: 'الأصناف' },
  { key: 'payments', label: 'المدفوعات' },
  { key: 'returns', label: 'إرجاع' },
  { key: 'details', label: 'تفاصيل' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') console.log(title, msg);
  else Alert.alert(title, msg);
}

export default function InvoiceForm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const invoiceId = isNew ? null : Number(id);
  const router = useRouter();
  const qc = useQueryClient();
  const { companyId, user, can } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [tab, setTab] = useState<TabKey>('basic');

  // header state
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [paymentType, setPaymentType] = useState<'credit' | 'cash' | 'bank'>('cash');
  const [cashBoxId, setCashBoxId] = useState<number | null>(null);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [loadedDoc, setLoadedDoc] = useState<any>(null);
  const [showCustomerPick, setShowCustomerPick] = useState(false);
  const [custSearch, setCustSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<number | 'all'>('all');

  // reference data
  const customersQ = useQuery({
    queryKey: ['customers', companyId],
    queryFn: () => api<any[]>(`/api/customers?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const itemsQ = useQuery({
    queryKey: ['items', companyId],
    queryFn: () => api<Item[]>(`/api/inventory/items?companyId=${companyId}&includeHidden=1`),
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
  const branchesQ = useQuery({
    queryKey: ['branches', companyId],
    queryFn: () => api<any[]>(`/api/org/branches?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const warehousesQ = useQuery({
    queryKey: ['warehouses', companyId],
    queryFn: () => api<any[]>(`/api/inventory/warehouses?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const docQ = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: () => api<any>(`/api/sales/sales-invoices/${invoiceId}?companyId=${companyId}`),
    enabled: !!companyId && !!invoiceId,
  });
  const vouchersQ = useQuery({
    queryKey: ['invoice-vouchers', invoiceId],
    queryFn: () => api<any[]>(`/api/receipt-vouchers?companyId=${companyId}&salesInvoiceId=${invoiceId}`),
    enabled: !!companyId && !!invoiceId,
  });

  // hydrate edit mode
  useEffect(() => {
    const d: any = docQ.data;
    if (!d || !d.id || loadedDoc) return;
    setLoadedDoc(d);
    setCustomerId(d.customerId ?? null);
    setInvoiceDate(String(d.invoiceDate ?? '').slice(0, 10) || todayISO());
    setPaymentType((d.paymentType as any) || 'cash');
    setCashBoxId(d.cashBoxId ?? null);
    setBankAccountId(d.bankAccountId ?? null);
    setPriceIncludesVat(!!d.priceIncludesVat);
    setNotes(d.notes ?? '');
    const ls: CartLine[] = (Array.isArray(d.lines) ? d.lines : []).map((l: any) => ({
      itemId: l.itemId,
      name: l.itemName ?? l.item?.nameAr ?? `صنف ${l.itemId}`,
      qty: parseFloat(l.qty ?? l.quantity ?? 1) || 1,
      unitPrice: parseFloat(l.unitPrice ?? 0) || 0,
      vatRate: parseFloat(l.vatRate ?? 15) || 0,
    }));
    setLines(ls);
  }, [docQ.data, loadedDoc]);

  const isPosted = loadedDoc && loadedDoc.status && loadedDoc.status !== 'draft';
  const readOnly = !!isPosted;

  const customers = Array.isArray(customersQ.data) ? customersQ.data : [];
  const items = Array.isArray(itemsQ.data) ? itemsQ.data : [];
  const cashBoxes = Array.isArray(cashBoxesQ.data) ? cashBoxesQ.data : [];
  const banks = Array.isArray(banksQ.data) ? banksQ.data : [];
  const customer = customers.find((x) => x.id === customerId) ?? null;

  // default branch: user's own branch first, then company's first branch
  const branches = Array.isArray(branchesQ.data) ? branchesQ.data : [];
  const branchId =
    loadedDoc?.branchId ??
    (user?.branchIds?.length ? user.branchIds[0] : null) ??
    (branches.find((b: any) => b.isDefault || b.is_default)?.id ?? branches[0]?.id ?? null);

  // default warehouse for stock lines
  const warehouses = Array.isArray(warehousesQ.data) ? warehousesQ.data : [];
  const defaultWarehouseId =
    (warehouses.find((w: any) => w.isDefault || w.is_default)?.id ?? warehouses[0]?.id ?? null);

  // groups for chips
  const groups = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of items) if (it.group?.id) m.set(it.group.id, it.group.nameAr ?? '');
    return [...m.entries()].map(([gid, name]) => ({ id: gid, name }));
  }, [items]);

  const visibleItems = useMemo(() => {
    let list = items;
    if (activeGroup !== 'all') list = list.filter((i) => i.group?.id === activeGroup);
    const s = itemSearch.trim();
    if (s) list = list.filter((i) => (i.nameAr ?? '').includes(s) || (i.code ?? '').includes(s) || (i.barcode ?? '').includes(s));
    return list.slice(0, 100);
  }, [items, activeGroup, itemSearch]);

  // totals — mirrors web logic (VAT add vs price-inclusive)
  const totals = useMemo(() => {
    let subtotal = 0, vat = 0;
    for (const l of lines) {
      const gross = l.qty * l.unitPrice;
      const r = (l.vatRate ?? 0) / 100;
      if (priceIncludesVat) {
        const net = gross / (1 + r);
        subtotal += net;
        vat += gross - net;
      } else {
        subtotal += gross;
        vat += gross * r;
      }
    }
    return { subtotal, vat, total: subtotal + vat };
  }, [lines, priceIncludesVat]);

  const addItem = (it: Item) => {
    if (readOnly) return;
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.itemId === it.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [
        ...prev,
        {
          itemId: it.id,
          name: it.nameAr ?? it.code ?? String(it.id),
          qty: 1,
          unitPrice: parseFloat(String(it.salePrice ?? 0)) || 0,
          vatRate: parseFloat(String(it.vatRate ?? 15)),
        },
      ];
    });
  };

  const setLineQty = (itemId: number, q: number) => {
    setLines((prev) => (q <= 0 ? prev.filter((l) => l.itemId !== itemId) : prev.map((l) => (l.itemId === itemId ? { ...l, qty: q } : l))));
  };

  const openScanner = () => {
    onScan((code) => {
      const it = items.find((i) => (i.barcode ?? '') === code || i.code === code);
      if (it) addItem(it);
      else notify('غير موجود', `لا يوجد صنف بالباركود ${code}`);
    });
    router.push('/scan');
  };
  useEffect(() => () => clearScan(), []);

  const buildBody = () => {
    const bodyLines = lines.map((l) => {
      const gross = l.qty * l.unitPrice;
      const it = items.find((i) => i.id === l.itemId);
      return {
        itemId: l.itemId,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
        discount: 0,
        discountAmount: 0,
        // mirrors the web form: line total is the entered (gross) amount
        lineTotal: +gross.toFixed(2),
        warehouseId: defaultWarehouseId ?? undefined,
        unitId: it?.unit?.id ?? undefined,
      };
    });
    return {
      companyId,
      invoiceDate,
      customerId,
      branchId,
      paymentType,
      cashBoxId: paymentType === 'cash' ? cashBoxId : null,
      bankAccountId: paymentType === 'bank' ? bankAccountId : null,
      priceIncludesVat,
      subtotal: +totals.subtotal.toFixed(2),
      vatAmount: +totals.vat.toFixed(2),
      discountAmount: 0,
      totalAmount: +totals.total.toFixed(2),
      notes: notes || undefined,
      lines: bodyLines,
    };
  };

  const validate = (): string => {
    if (!lines.length) return 'أضف صنفاً واحداً على الأقل';
    if (!customerId) return 'اختر العميل (للبيع النقدي اختر «عميل نقدي»)';
    if (!branchId) return 'لا يوجد فرع معرّف لحسابك — تواصل مع مدير النظام';
    if (paymentType === 'cash' && !cashBoxId && cashBoxes.length > 0) return 'اختر الصندوق';
    if (paymentType === 'bank' && !bankAccountId) return 'اختر الحساب البنكي';
    return '';
  };

  const save = async (thenPost: boolean) => {
    const err = validate();
    if (err) { setSaveError(err); setTab(err.includes('صنف') ? 'items' : 'basic'); return; }
    setSaveError('');
    thenPost ? setPosting(true) : setSaving(true);
    try {
      let docId = invoiceId;
      if (isNew && !loadedDoc) {
        const created = await api<any>('/api/sales/sales-invoices', { method: 'POST', body: buildBody() });
        docId = created?.id ?? created?.invoice?.id;
        setLoadedDoc(created?.invoice ?? created);
      } else {
        await api(`/api/sales/sales-invoices/${docId}`, { method: 'PUT', body: buildBody() });
      }
      if (thenPost && docId) {
        await api(`/api/sales/sales-invoices/${docId}/post`, { method: 'PATCH', body: { companyId } });
      }
      qc.invalidateQueries({ queryKey: ['sales-invoices', companyId] });
      notify('تم', thenPost ? 'تم حفظ الفاتورة وإصدارها' : 'تم حفظ الفاتورة كمسودة');
      router.back();
    } catch (e: any) {
      setSaveError(e?.message ?? 'فشل الحفظ');
    } finally {
      setSaving(false);
      setPosting(false);
    }
  };

  // Unpost — same server-side policy as web (posting-rights matrix enforced by
  // requireUnpostRight; ZATCA-reported invoices are rejected by the server).
  const [unposting, setUnposting] = useState(false);
  const doUnpost = async () => {
    const go = async () => {
      setUnposting(true);
      try {
        await api(`/api/sales/sales-invoices/${invoiceId}/unpost`, { method: 'PATCH', body: { companyId } });
        await qc.invalidateQueries({ queryKey: ['sales-invoices'] });
        await qc.invalidateQueries({ queryKey: ["sales-invoice", invoiceId] });
        notify('تم', 'تم فك ترحيل الفاتورة — أصبحت مسودة قابلة للتعديل');
      } catch (e: any) {
        notify('تعذّر فك الترحيل', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setUnposting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('فك الترحيل', 'سيتم عكس القيود وحركات المخزون وتصبح الفاتورة مسودة. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'فك الترحيل', style: 'destructive', onPress: go },
    ]);
  };

  // Print / share (posted invoices only) — قالب 14 «الأصلي» مع QR زاتكا
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const doPrint = async (share: boolean) => {
    if (!loadedDoc) return;
    share ? setSharing(true) : setPrinting(true);
    try {
      const input = {
        doc: loadedDoc,
        lines: Array.isArray(loadedDoc.lines) ? loadedDoc.lines : [],
        customer,
        company: user?.company ?? {},
        logoUrl: null,
      };
      if (share) await shareInvoicePdf(input);
      else await printInvoice(input);
    } catch (e: any) {
      notify('خطأ', typeof e === 'string' ? e : e?.message ?? 'تعذّرت الطباعة');
    } finally {
      setPrinting(false);
      setSharing(false);
    }
  };

  const Seg = ({ options, value, onChange }: { options: { v: string; l: string }[]; value: string; onChange: (v: any) => void }) => (
    <View style={{ flexDirection: 'row-reverse', backgroundColor: c.muted, borderRadius: 12, padding: 3 }}>
      {options.map((o) => (
        <Pressable
          key={o.v}
          disabled={readOnly}
          onPress={() => onChange(o.v)}
          style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: value === o.v ? c.card : 'transparent', alignItems: 'center' }}
        >
          <Text style={{ fontSize: 13, fontFamily: value === o.v ? 'Inter_600SemiBold' : 'Inter_400Regular', color: value === o.v ? c.primary : c.mutedForeground }}>
            {o.l}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  const PickRow = ({ label, value, onPress, testID }: { label: string; value: string; onPress: () => void; testID?: string }) => (
    <Pressable
      testID={testID}
      disabled={readOnly}
      onPress={onPress}
      style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 12, backgroundColor: c.card }}
    >
      <Text style={{ fontSize: 13, color: c.mutedForeground }}>{label}</Text>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: 14, color: c.foreground, fontFamily: 'Inter_500Medium' }}>{value}</Text>
        <Feather name="chevron-down" size={16} color={c.mutedForeground} />
      </View>
    </Pressable>
  );

  if (invoiceId && docQ.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* header */}
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 10, paddingHorizontal: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' }}>
            {isNew && !loadedDoc ? 'فاتورة مبيعات جديدة' : `فاتورة ${loadedDoc?.docNumber ?? ''}`}
          </Text>
          <Pressable onPress={() => router.back()} hitSlop={10} testID="button-close-invoice">
            <Feather name="x" size={22} color="#fff" />
          </Pressable>
        </View>
        {/* step tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: 'row-reverse' }}>
          {TABS.map((tb, i) => (
            <Pressable
              key={tb.key}
              onPress={() => setTab(tb.key)}
              style={{
                flexDirection: 'row-reverse',
                alignItems: 'center',
                gap: 6,
                backgroundColor: tab === tb.key ? '#fff' : 'rgba(255,255,255,0.15)',
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
              }}
            >
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: tab === tb.key ? c.primary : 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>{i + 1}</Text>
              </View>
              <Text style={{ color: tab === tb.key ? c.primary : '#fff', fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>{tb.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* body */}
      <View style={{ flex: 1 }}>
        {tab === 'basic' && (
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
            <Card style={{ gap: 12 }}>
              <Text style={{ fontSize: 12, color: c.mutedForeground, textAlign: 'right' }}>
                نوع الفاتورة (ضريبية / مبسطة) يتحدد تلقائياً حسب الرقم الضريبي للعميل — كما في النظام الرئيسي.
              </Text>
              <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>طريقة الدفع</Text>
              <Seg
                options={[{ v: 'cash', l: 'نقدي' }, { v: 'bank', l: 'بنك/شبكة' }, { v: 'credit', l: 'آجل' }]}
                value={paymentType}
                onChange={setPaymentType}
              />
              {paymentType === 'cash' && cashBoxes.length > 0 ? (
                <PickRow
                  label="الصندوق"
                  value={cashBoxes.find((b) => b.id === cashBoxId)?.nameAr ?? 'اختر'}
                  onPress={() => {
                    const idx = cashBoxes.findIndex((b) => b.id === cashBoxId);
                    setCashBoxId(cashBoxes[(idx + 1) % cashBoxes.length]?.id ?? null);
                  }}
                  testID="pick-cashbox"
                />
              ) : null}
              {paymentType === 'bank' ? (
                <PickRow
                  label="الحساب البنكي"
                  value={banks.find((b) => b.id === bankAccountId)?.nameAr ?? 'اختر'}
                  onPress={() => {
                    const idx = banks.findIndex((b) => b.id === bankAccountId);
                    setBankAccountId(banks[(idx + 1) % banks.length]?.id ?? null);
                  }}
                  testID="pick-bank"
                />
              ) : null}
              <PickRow
                label="العميل"
                value={customer?.nameAr ?? 'اختر عميلاً *'}
                onPress={() => setShowCustomerPick(true)}
                testID="pick-customer"
              />
              <Field label="تاريخ الفاتورة (YYYY-MM-DD)" value={invoiceDate} onChangeText={setInvoiceDate} ltr testID="input-invoice-date" />
              <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14, color: c.foreground }}>الأسعار تشمل الضريبة</Text>
                <Pressable
                  testID="toggle-price-includes-vat"
                  disabled={readOnly}
                  onPress={() => setPriceIncludesVat((v) => !v)}
                  style={{ width: 48, height: 28, borderRadius: 14, backgroundColor: priceIncludesVat ? c.primary : c.muted, padding: 3, alignItems: priceIncludesVat ? 'flex-start' : 'flex-end', flexDirection: 'row' }}
                >
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' }} />
                </Pressable>
              </View>
            </Card>
            <Btn title="التالي: الأصناف" onPress={() => setTab('items')} icon="arrow-left" />
          </ScrollView>
        )}

        {tab === 'items' && (
          <View style={{ flex: 1 }}>
            <View style={{ padding: 12, gap: 10 }}>
              <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
                <View style={{ flex: 1, flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: c.card, borderWidth: 1.2, borderColor: c.input, borderRadius: 12, paddingHorizontal: 10 }}>
                  <Feather name="search" size={16} color={c.mutedForeground} />
                  <TextInput
                    value={itemSearch}
                    onChangeText={setItemSearch}
                    placeholder="بحث بالاسم أو الكود أو الباركود"
                    placeholderTextColor={c.mutedForeground}
                    style={{ flex: 1, paddingVertical: 9, textAlign: 'right', fontSize: 14, color: c.foreground }}
                    testID="input-item-search"
                  />
                </View>
                {!readOnly && Platform.OS !== 'web' ? (
                  <Pressable testID="button-scan" onPress={openScanner} style={{ backgroundColor: c.primary, borderRadius: 12, padding: 11 }}>
                    <Feather name="camera" size={18} color="#fff" />
                  </Pressable>
                ) : null}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, flexDirection: 'row-reverse' }}>
                <Chip label="الكل" active={activeGroup === 'all'} onPress={() => setActiveGroup('all')} />
                {groups.map((g) => (
                  <Chip key={g.id} label={g.name} active={activeGroup === g.id} onPress={() => setActiveGroup(g.id)} />
                ))}
              </ScrollView>
            </View>

            <FlatList
              data={visibleItems}
              keyExtractor={(i) => String(i.id)}
              contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingBottom: 130 }}
              ListEmptyComponent={itemsQ.isLoading ? null : <Empty icon="package" text="لا توجد أصناف" />}
              renderItem={({ item }) => {
                const inCart = lines.find((l) => l.itemId === item.id);
                return (
                  <View style={{ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: inCart ? c.primary : c.border, padding: 11, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ textAlign: 'right', fontSize: 14, fontFamily: 'Inter_500Medium', color: c.foreground }}>{item.nameAr}</Text>
                      <Text style={{ textAlign: 'right', fontSize: 12, color: c.mutedForeground }}>
                        {item.code ?? ''} · {money(item.salePrice)}
                      </Text>
                    </View>
                    {inCart ? (
                      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8 }}>
                        <Pressable onPress={() => setLineQty(item.id, inCart.qty + 1)} style={{ backgroundColor: c.primary, borderRadius: 8, padding: 6 }}>
                          <Feather name="plus" size={14} color="#fff" />
                        </Pressable>
                        <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', color: c.foreground, minWidth: 26, textAlign: 'center' }}>{fq(inCart.qty)}</Text>
                        <Pressable onPress={() => setLineQty(item.id, inCart.qty - 1)} style={{ backgroundColor: c.muted, borderRadius: 8, padding: 6 }}>
                          <Feather name="minus" size={14} color={c.foreground} />
                        </Pressable>
                      </View>
                    ) : (
                      <Pressable testID={`button-add-item-${item.id}`} disabled={readOnly} onPress={() => addItem(item)} style={{ backgroundColor: c.secondary, borderRadius: 10, padding: 9 }}>
                        <Feather name="plus" size={16} color={c.primary} />
                      </Pressable>
                    )}
                  </View>
                );
              }}
            />

            {/* cart footer */}
            <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{lines.length} صنف · الإجمالي شامل الضريبة</Text>
                <Text style={{ color: c.primary, fontSize: 17, fontFamily: 'Inter_700Bold' }}>{money(totals.total)}</Text>
              </View>
              <Btn title="التالي: التفاصيل والحفظ" onPress={() => setTab('details')} icon="arrow-left" small />
            </View>
          </View>
        )}

        {tab === 'payments' && (
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
            {!loadedDoc ? (
              <Card><Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 14 }}>احفظ الفاتورة أولاً لعرض المدفوعات المرتبطة بها.</Text></Card>
            ) : (
              <>
                {(Array.isArray(vouchersQ.data) ? vouchersQ.data : []).map((v: any) => (
                  <Card key={v.id} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                      <Text style={{ fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{v.docNumber ?? `سند #${v.id}`}</Text>
                      <Text style={{ color: c.primary, fontFamily: 'Inter_700Bold' }}>{money(v.amount)}</Text>
                    </View>
                    <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 12 }}>{showDate(v.date)} · {v.paymentType === 'bank' ? 'بنك' : 'نقدي'}</Text>
                  </Card>
                ))}
                {(!vouchersQ.data || (Array.isArray(vouchersQ.data) && vouchersQ.data.length === 0)) ? (
                  <Empty icon="download" text="لا توجد سندات قبض مرتبطة بهذه الفاتورة" />
                ) : null}
                {loadedDoc?.id && paymentType === 'credit' ? (
                  <Btn title="إنشاء سند قبض لهذه الفاتورة" icon="plus" kind="outline" onPress={() => router.push({ pathname: '/voucher/new', params: { invoiceId: String(loadedDoc.id), customerId: String(customerId ?? '') } } as any)} />
                ) : null}
              </>
            )}
          </ScrollView>
        )}

        {tab === 'returns' && (
          <ScrollView contentContainerStyle={{ padding: 14 }}>
            <Card>
              <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 14, lineHeight: 22 }}>
                إنشاء إشعار دائن (مرتجع) من الجوال سيتوفر في التحديث القادم. يمكنك حالياً إنشاء المرتجع من النظام الرئيسي على الويب لنفس الفاتورة.
              </Text>
            </Card>
          </ScrollView>
        )}

        {tab === 'details' && (
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
            <Card style={{ gap: 10 }}>
              {lines.map((l) => (
                <View key={l.itemId} style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', borderBottomWidth: StyleShim, borderBottomColor: c.border, paddingBottom: 6 }}>
                  <Text style={{ fontSize: 13, color: c.foreground, flex: 1, textAlign: 'right' }}>{l.name} × {fq(l.qty)}</Text>
                  <Text style={{ fontSize: 13, color: c.foreground, fontFamily: 'Inter_600SemiBold' }}>{money(l.qty * l.unitPrice)}</Text>
                </View>
              ))}
              {!lines.length ? <Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا توجد أصناف — ارجع لتبويب الأصناف</Text> : null}
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.mutedForeground }}>الإجمالي قبل الضريبة</Text>
                <Text style={{ fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{money(totals.subtotal)}</Text>
              </View>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.mutedForeground }}>ضريبة القيمة المضافة</Text>
                <Text style={{ fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{money(totals.vat)}</Text>
              </View>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
                <Text style={{ fontFamily: 'Inter_700Bold', color: c.foreground }}>الإجمالي</Text>
                <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 17, color: c.primary }}>{money(totals.total)}</Text>
              </View>
            </Card>
            <Card>
              <Field label="ملاحظات" value={notes} onChangeText={setNotes} multiline testID="input-notes" />
            </Card>
            {saveError ? <Text style={{ color: c.destructive, textAlign: 'right', fontSize: 13 }}>{saveError}</Text> : null}
            {!readOnly ? (
              <View style={{ gap: 10 }}>
                <Btn title="حفظ وإصدار الفاتورة" onPress={() => save(true)} loading={posting} icon="check-circle" testID="button-save-post" />
                <Btn title="حفظ كمسودة" onPress={() => save(false)} loading={saving} kind="outline" testID="button-save-draft" />
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>هذه الفاتورة صادرة — للعرض فقط.</Text></Card>
                <Btn title="طباعة الفاتورة" icon="printer" loading={printing} onPress={() => doPrint(false)} testID="button-print" />
                <Btn title="مشاركة PDF (واتساب / بريد)" icon="share-2" kind="outline" loading={sharing} onPress={() => doPrint(true)} testID="button-share" />
                {can('sales_invoices', 'post') ? (
                  <Btn title="فك ترحيل الفاتورة" icon="rotate-ccw" kind="destructive" loading={unposting} onPress={doUnpost} testID="button-unpost" />
                ) : null}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      {/* customer picker */}
      <Modal visible={showCustomerPick} transparent animationType="slide" onRequestClose={() => setShowCustomerPick(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>اختيار العميل</Text>
            <TextInput
              value={custSearch}
              onChangeText={setCustSearch}
              placeholder="بحث..."
              placeholderTextColor={c.mutedForeground}
              style={{ borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 10, textAlign: 'right', color: c.foreground }}
            />
            <FlatList
              data={[{ id: null as any, nameAr: 'بدون عميل (نقدي)' }, ...customers.filter((x) => !custSearch.trim() || (x.nameAr ?? '').includes(custSearch.trim()))]}
              keyExtractor={(x) => String(x.id ?? 'none')}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { setCustomerId(item.id); setShowCustomerPick(false); }}
                  style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: StyleShim, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between' })}
                >
                  <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>{item.nameAr}</Text>
                  {customerId === item.id ? <Feather name="check" size={16} color={c.primary} /> : null}
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const StyleShim = 1;
