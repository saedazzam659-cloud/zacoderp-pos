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
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, qty as fq, todayISO } from '@/lib/format';
import { onScan, clearScan } from '@/lib/scanBus';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Chip, Empty, Field } from '@/components/ui';
import { NumericEntry } from '@/components/NumericEntry';
import { calcInvoiceLine, syncLineDiscount } from '@/lib/invoiceLineCalc';
import { printInvoice, shareInvoicePdf } from '@/lib/print';

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
  freeQty: number;
  discount: number;
  discountAmount: number;
  unitId?: number;
  unitName?: string;
  conversionFactor: number;
}

// عرض السعر = فاتورة مبيعات بلا تبويبي المدفوعات والإرجاع
const TABS = [
  { key: 'basic', label: 'بيانات أساسية' },
  { key: 'items', label: 'الأصناف' },
  { key: 'details', label: 'تفاصيل' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const STATUS_AR: Record<string, string> = {
  draft: 'مسودة',
  sent: 'مرسل',
  accepted: 'مقبول',
  rejected: 'مرفوض',
  converted: 'محوّل لفاتورة',
};

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') console.log(title, msg);
  else Alert.alert(title, msg);
}

export default function QuotationForm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const quotationId = isNew ? null : Number(id);
  const router = useRouter();
  const qc = useQueryClient();
  const { companyId, user } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [tab, setTab] = useState<TabKey>('basic');

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [quotationDate, setQuotationDate] = useState(todayISO());
  const [validUntil, setValidUntil] = useState('');
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [loadedDoc, setLoadedDoc] = useState<any>(null);
  const [showCustomerPick, setShowCustomerPick] = useState(false);
  const [branchSel, setBranchSel] = useState<number | null>(null);
  const [currencySel, setCurrencySel] = useState<number | null>(null);
  const [pick, setPick] = useState<null | 'branch' | 'currency'>(null);
  const [custSearch, setCustSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<number | 'all'>('all');
  const [itemUnits, setItemUnits] = useState<Record<number, any[]>>({});

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
  const branchesQ = useQuery({
    queryKey: ['branches', companyId],
    queryFn: () => api<any[]>(`/api/org/branches?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const currenciesQ = useQuery({
    queryKey: ['currencies', companyId],
    queryFn: () => api<any[]>(`/api/currencies?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const docQ = useQuery({
    queryKey: ['sales-quotation', quotationId],
    queryFn: () => api<any>(`/api/sales/sales-quotations/${quotationId}?companyId=${companyId}`),
    enabled: !!companyId && !!quotationId,
  });

  // hydrate edit mode
  useEffect(() => {
    const d: any = docQ.data;
    if (!d || !d.id || loadedDoc) return;
    setLoadedDoc(d);
    setCustomerId(d.customerId ?? null);
    setQuotationDate(String(d.quotationDate ?? '').slice(0, 10) || todayISO());
    setValidUntil(String(d.validUntil ?? '').slice(0, 10));
    setPriceIncludesVat(!!d.priceIncludesVat);
    setNotes(d.notes ?? '');
    if (d.branchId) setBranchSel(d.branchId);
    const ls: CartLine[] = (Array.isArray(d.lines) ? d.lines : []).map((l: any) => ({
      itemId: l.itemId,
      name: l.itemName ?? l.item?.nameAr ?? `صنف ${l.itemId}`,
      qty: parseFloat(l.qty ?? 1) || 1,
      unitPrice: parseFloat(l.unitPrice ?? 0) || 0,
      vatRate: parseFloat(l.vatRate ?? 15) || 0,
      freeQty: parseFloat(l.freeQty ?? 0) || 0,
      discount: parseFloat(l.discount ?? 0) || 0,
      discountAmount: parseFloat(l.discountAmount ?? 0) || 0,
      unitId: l.unitId ?? l.unit?.id,
      unitName: l.unit?.nameAr ?? l.unitName ?? (typeof l.unit === 'string' ? l.unit : undefined),
      conversionFactor: parseFloat(l.conversionFactor ?? 1) || 1,
    }));
    setLines(ls);
  }, [docQ.data, loadedDoc]);

  const status: string = loadedDoc?.status ?? 'draft';
  // مسودة/مرسل فقط قابلة للتعديل؛ المقبول/المرفوض/المحوّل للعرض فقط
  const readOnly = !!loadedDoc && !['draft', 'sent'].includes(status);

  const customers = Array.isArray(customersQ.data) ? customersQ.data : [];
  const items = Array.isArray(itemsQ.data) ? itemsQ.data : [];
  const customer = customers.find((x) => x.id === customerId) ?? null;

  const branches = Array.isArray(branchesQ.data) ? branchesQ.data : [];
  const defaultBranchId =
    loadedDoc?.branchId ??
    (user?.branchIds?.length ? user.branchIds[0] : null) ??
    (branches.find((b: any) => b.isDefault || b.is_default)?.id ?? branches[0]?.id ?? null);
  const branchId = branchSel ?? defaultBranchId;

  const currencies = Array.isArray(currenciesQ.data) ? currenciesQ.data : [];
  const defaultCurrency =
    currencies.find((x: any) => x.isDefault || x.is_default) ??
    currencies.find((x: any) => String(x.code ?? '').toUpperCase() === 'SAR') ??
    currencies[0] ?? null;
  const currency = currencies.find((x: any) => x.id === currencySel) ?? defaultCurrency;

  useEffect(() => {
    if (!loadedDoc?.currencyCode || currencySel != null || !currencies.length) return;
    const m = currencies.find((x: any) => String(x.code ?? '').toUpperCase() === String(loadedDoc.currencyCode).toUpperCase());
    if (m) setCurrencySel(m.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDoc?.currencyCode, currencies.length]);

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

  const totals = useMemo(() => {
    let subtotal = 0, vat = 0;
    for (const l of lines) {
      const amounts = calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount');
      subtotal += amounts.subtotal;
      vat += amounts.vat;
    }
    return { subtotal, vat, total: subtotal + vat };
  }, [lines, priceIncludesVat, user?.company?.taxCalculationMode]);

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
          freeQty: 0,
          discount: 0,
          discountAmount: 0,
          unitId: it.unit?.id,
          unitName: it.unit?.nameAr,
          conversionFactor: 1,
        },
      ];
    });
  };

  const setLineQty = (itemId: number, q: number) => {
    setLines((prev) => (q <= 0 ? prev.filter((l) => l.itemId !== itemId) : prev.map((l) => (l.itemId === itemId ? { ...l, qty: q } : l))));
  };

  const setLinePrice = (itemId: number, price: number) => {
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, unitPrice: Math.max(0, price) } : l)));
  };

  const setLineField = (itemId: number, field: 'freeQty' | 'discount' | 'discountAmount', value: number) => {
    setLines((prev) => prev.map((l) => {
      if (l.itemId !== itemId) return l;
      if (field === 'freeQty') return { ...l, freeQty: Math.max(0, value) };
      return { ...l, ...syncLineDiscount(l, field, value) };
    }));
  };

  const selectNextUnit = async (line: CartLine) => {
    let options = itemUnits[line.itemId];
    try {
      if (!options) {
        options = await api<any[]>(`/api/inventory/items/${line.itemId}/units?companyId=${companyId}`);
        setItemUnits((prev) => ({ ...prev, [line.itemId]: options }));
      }
    } catch (e: any) {
      notify('تعذّر تحميل الوحدات', e?.message ?? 'أعد المحاولة');
      return;
    }
    if (!options.length) return;
    const current = options.findIndex((u: any) => Number(u.unitId) === line.unitId);
    const next = options[(current + 1) % options.length];
    setLines((prev) => prev.map((l) => l.itemId === line.itemId ? {
      ...l,
      unitId: Number(next.unitId),
      unitName: next.unit?.nameAr ?? next.unitNameAr ?? next.nameAr ?? String(next.unitId),
      conversionFactor: parseFloat(String(next.conversionFactor ?? 1)) || 1,
      unitPrice: next.salePrice != null ? parseFloat(String(next.salePrice)) || 0 : l.unitPrice,
    } : l));
  };

  useFocusEffect(
    React.useCallback(() => {
      if (companyId) itemsQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [companyId]),
  );

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
      const it = items.find((i) => i.id === l.itemId);
      const lineTotal = calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount').total;
      return {
        itemId: l.itemId,
        itemName: l.name,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
        freeQty: l.freeQty,
        discount: l.discount,
        discountAmount: l.discountAmount,
        lineTotal: +lineTotal.toFixed(2),
        unitId: l.unitId ?? it?.unit?.id ?? undefined,
        conversionFactor: l.conversionFactor,
      };
    });
    return {
      companyId,
      quotationDate,
      validUntil: validUntil || undefined,
      customerId,
      branchId,
      currencyCode: currency?.code ?? 'SAR',
      exchangeRate: String(currency?.exchangeRate ?? currency?.rate ?? '1'),
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
    if (!customerId) return 'اختر العميل';
    if (!branchId) return 'لا يوجد فرع معرّف لحسابك — تواصل مع مدير النظام';
    return '';
  };

  const save = async () => {
    const err = validate();
    if (err) { setSaveError(err); setTab(err.includes('صنف') ? 'items' : 'basic'); return; }
    setSaveError('');
    setSaving(true);
    try {
      if (isNew && !loadedDoc) {
        const created = await api<any>('/api/sales/sales-quotations', { method: 'POST', body: buildBody() });
        setLoadedDoc(created?.quotation ?? created);
      } else {
        await api(`/api/sales/sales-quotations/${loadedDoc?.id ?? quotationId}`, { method: 'PUT', body: buildBody() });
      }
      qc.invalidateQueries({ queryKey: ['sales-quotations', companyId] });
      notify('تم', 'تم حفظ عرض السعر');
      router.back();
    } catch (e: any) {
      setSaveError(typeof e === 'string' ? e : e?.message ?? 'فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  // تغيير الحالة (إرسال/قبول/رفض) — نفس مسارات الويب
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const setStatus = async (next: string) => {
    setStatusBusy(next);
    try {
      const row = await api<any>(`/api/sales/sales-quotations/${loadedDoc.id}/status?companyId=${companyId}`, {
        method: 'PATCH', body: { companyId, status: next },
      });
      setLoadedDoc(row);
      qc.invalidateQueries({ queryKey: ['sales-quotations', companyId] });
    } catch (e: any) {
      notify('تعذّر تغيير الحالة', typeof e === 'string' ? e : e?.message ?? 'خطأ');
    } finally {
      setStatusBusy(null);
    }
  };

  // تحويل عرض مقبول إلى فاتورة مبيعات (مسودة) — نفس سياسة الويب:
  // السيرفر يقفل العرض بحالة «محوّل» فور التحويل، ثم نفتح الفاتورة للحفظ/الإصدار.
  const [converting, setConverting] = useState(false);
  const doConvert = async () => {
    const go = async () => {
      setConverting(true);
      try {
        const r = await api<any>(`/api/sales/sales-quotations/${loadedDoc.id}/convert?companyId=${companyId}`, {
          method: 'POST', body: { companyId },
        });
        qc.invalidateQueries({ queryKey: ['sales-quotations', companyId] });
        qc.invalidateQueries({ queryKey: ['sales-invoices', companyId] });
        const invId = r?.invoice?.id;
        if (invId) router.replace(`/invoice/${invId}` as any);
        else { notify('تم', 'تم التحويل إلى فاتورة مبيعات'); router.back(); }
      } catch (e: any) {
        notify('تعذّر التحويل', typeof e === 'string' ? e : e?.message ?? 'خطأ');
      } finally {
        setConverting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('تحويل إلى فاتورة', 'سيتم إنشاء فاتورة مبيعات من هذا العرض وإغلاق العرض نهائياً. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'تحويل', onPress: go },
    ]);
  };

  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    const go = async () => {
      setDeleting(true);
      try {
        await api(`/api/sales/sales-quotations/${loadedDoc?.id ?? quotationId}?companyId=${companyId}`, { method: 'DELETE' });
        qc.invalidateQueries({ queryKey: ['sales-quotations', companyId] });
        notify('تم', 'تم حذف عرض السعر');
        router.back();
      } catch (e: any) {
        notify('تعذّر الحذف', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setDeleting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('حذف عرض السعر', 'سيتم حذف عرض السعر نهائياً. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'حذف', style: 'destructive', onPress: go },
    ]);
  };

  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const doPrint = async (share: boolean) => {
    const docId = loadedDoc?.id ?? quotationId;
    if (!docId) return;
    share ? setSharing(true) : setPrinting(true);
    try {
      const full = await api<any>(`/api/sales/sales-quotations/${docId}?companyId=${companyId}`);
      const input = {
        type: 'quotation' as const,
        doc: full,
        lines: Array.isArray(full?.lines) ? full.lines : [],
        customer: full?.customer ?? customer,
        company: user?.company ?? {},
        currency: full?.currency ?? currency,
        logoUrl: typeof user?.company?.logo === 'string' ? user.company.logo : null,
      };
      if (share) await shareInvoicePdf(input);
      else await printInvoice(input);
    } catch (e: any) {
      notify('خطأ', typeof e === 'string' ? e : e?.message ?? 'تعذّرت طباعة عرض السعر');
    } finally {
      setPrinting(false);
      setSharing(false);
    }
  };

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

  if (quotationId && docQ.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }

  const canEditDoc = isNew ? mp('quotation_create') : mp('quotation_edit');

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* header */}
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 10, paddingHorizontal: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' }}>
            {isNew && !loadedDoc ? 'عرض سعر جديد' : `عرض سعر ${loadedDoc?.docNumber ?? ''} · ${STATUS_AR[status] ?? status}`}
          </Text>
          <Pressable onPress={() => router.back()} hitSlop={10} testID="button-close-quotation">
            <Feather name="x" size={22} color="#fff" />
          </Pressable>
        </View>
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
              <PickRow
                label="العميل"
                value={customer?.nameAr ?? 'اختر عميلاً *'}
                onPress={() => setShowCustomerPick(true)}
                testID="pick-customer"
              />
              <PickRow
                label="الفرع"
                value={branches.find((b: any) => b.id === branchId)?.nameAr ?? '—'}
                onPress={() => { if (branches.length > 1) setPick('branch'); }}
                testID="pick-branch"
              />
              <PickRow
                label="العملة"
                value={currency ? `${currency.nameAr ?? currency.code}${(currency.isDefault || currency.is_default) ? ' (افتراضية)' : ''}` : 'ريال سعودي'}
                onPress={() => { if (currencies.length > 1) setPick('currency'); }}
                testID="pick-currency"
              />
              <Field label="تاريخ العرض (YYYY-MM-DD)" value={quotationDate} onChangeText={setQuotationDate} ltr testID="input-quotation-date" />
              <Field label="صالح حتى (YYYY-MM-DD، اختياري)" value={validUntil} onChangeText={setValidUntil} ltr testID="input-valid-until" />
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
                      <View style={{ flex: 1, gap: 6 }}>
                        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 7 }}>
                          {!readOnly ? (
                            <NumericEntry
                              testID={`input-cart-price-${item.id}`}
                              value={inCart.unitPrice}
                              onChangeValue={(v) => setLinePrice(item.id, v)}
                              style={{ minWidth: 64, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 6, textAlign: 'center', fontSize: 13, color: c.foreground, backgroundColor: c.background }}
                            />
                          ) : null}
                          <Pressable onPress={() => setLineQty(item.id, inCart.qty + 1)} style={{ backgroundColor: c.primary, borderRadius: 8, padding: 6 }}>
                            <Feather name="plus" size={14} color="#fff" />
                          </Pressable>
                          {!readOnly ? (
                            <NumericEntry
                              testID={`input-cart-qty-${item.id}`}
                              value={inCart.qty}
                              blankWhenZero={false}
                              blankWhenOne
                              onChangeValue={(q) => setLineQty(item.id, q)}
                              style={{ width: 52, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 4, textAlign: 'center', fontSize: 14, fontFamily: 'Inter_700Bold', color: c.foreground, backgroundColor: c.background }}
                            />
                          ) : (
                            <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', color: c.foreground, minWidth: 26, textAlign: 'center' }}>{fq(inCart.qty)}</Text>
                          )}
                          <Pressable onPress={() => setLineQty(item.id, inCart.qty - 1)} style={{ backgroundColor: c.muted, borderRadius: 8, padding: 6 }}>
                            <Feather name="minus" size={14} color={c.foreground} />
                          </Pressable>
                        </View>
                        {!readOnly && (mp('invoice_free_qty') || mp('invoice_discount') || mp('invoice_unit_selection')) ? (
                          <View style={{ gap: 6 }}>
                            <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 6 }}>
                              {mp('invoice_free_qty') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>مجاني</Text>
                                  <NumericEntry testID={`input-cart-free-qty-${item.id}`} value={inCart.freeQty} emptyValue={0}
                                    onChangeValue={(v) => setLineField(item.id, 'freeQty', v)}
                                    style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                </View>
                              ) : null}
                              {mp('invoice_discount') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم %</Text>
                                  <NumericEntry testID={`input-cart-discount-${item.id}`} value={inCart.discount} emptyValue={0}
                                    onChangeValue={(v) => setLineField(item.id, 'discount', v)}
                                    style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                </View>
                              ) : null}
                              {mp('invoice_discount') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم قيمة</Text>
                                  <NumericEntry testID={`input-cart-discount-amount-${item.id}`} value={inCart.discountAmount} emptyValue={0}
                                    onChangeValue={(v) => setLineField(item.id, 'discountAmount', v)}
                                    style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                </View>
                              ) : null}
                            </View>
                            {mp('invoice_unit_selection') ? (
                              <Pressable onPress={() => selectNextUnit(inCart)} testID={`button-cart-unit-${item.id}`} style={{ alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.muted }}>
                                <Text style={{ fontSize: 11, color: c.foreground }}>{inCart.unitName ?? 'وحدة'}</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        ) : null}
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

            <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{lines.length} صنف · الإجمالي شامل الضريبة</Text>
                <Text style={{ color: c.primary, fontSize: 17, fontFamily: 'Inter_700Bold' }}>{money(totals.total)}</Text>
              </View>
              <Btn title="التالي: التفاصيل والحفظ" onPress={() => setTab('details')} icon="arrow-left" small />
            </View>
          </View>
        )}

        {tab === 'details' && (
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
            <Card style={{ gap: 10 }}>
              {lines.map((l) => (
                <View key={l.itemId} style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 6 }}>
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
              !canEditDoc ? (
                <View style={{ gap: 10 }}>
                  <Card><Text style={{ textAlign: 'right', color: c.destructive }}>{isNew ? 'ليست لديك صلاحية إنشاء عرض سعر من التطبيق — تواصل مع مدير النظام.' : 'ليست لديك صلاحية تعديل عروض الأسعار من التطبيق — تواصل مع مدير النظام.'}</Text></Card>
                  {loadedDoc && mp('quotation_delete') ? (
                    <Btn title="حذف عرض السعر" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-quotation" />
                  ) : null}
                </View>
              ) : (
                <View style={{ gap: 10 }}>
                  <Btn title="حفظ عرض السعر" onPress={save} loading={saving} icon="check-circle" testID="button-save-quotation" />
                  {loadedDoc ? (
                    <>
                      {status === 'draft' ? (
                        <Btn title="تحديد كمرسل للعميل" icon="send" kind="outline" loading={statusBusy === 'sent'} onPress={() => setStatus('sent')} testID="button-mark-sent" />
                      ) : null}
                      <Btn title="قبول العرض (تمهيداً للتحويل)" icon="thumbs-up" kind="outline" loading={statusBusy === 'accepted'} onPress={() => setStatus('accepted')} testID="button-mark-accepted" />
                      <Btn title="رفض العرض" icon="thumbs-down" kind="outline" loading={statusBusy === 'rejected'} onPress={() => setStatus('rejected')} testID="button-mark-rejected" />
                      {mp('quotation_delete') ? (
                        <Btn title="حذف عرض السعر" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-quotation" />
                      ) : null}
                    </>
                  ) : null}
                </View>
              )
            ) : (
              <View style={{ gap: 10 }}>
                <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>
                  {status === 'converted'
                    ? 'هذا العرض تم تحويله إلى فاتورة مبيعات — مغلق للعرض فقط.'
                    : status === 'accepted'
                      ? 'العرض مقبول — يمكن تحويله إلى فاتورة مبيعات.'
                      : 'العرض مرفوض — للعرض فقط.'}
                </Text></Card>
                {status === 'accepted' && mp('quotation_edit') && mp('invoice_create') ? (
                  <Btn title="تحويل إلى فاتورة مبيعات" icon="file-plus" loading={converting} onPress={doConvert} testID="button-convert-quotation" />
                ) : null}
                {status === 'converted' && loadedDoc?.convertedInvoiceId ? (
                  <Btn title="فتح الفاتورة الناتجة" icon="external-link" kind="outline" onPress={() => router.push(`/invoice/${loadedDoc.convertedInvoiceId}` as any)} />
                ) : null}
              </View>
            )}
            {!isNew ? (
              <View style={{ gap: 10 }}>
                <Btn title="طباعة عرض السعر (نموذج 14)" icon="printer" loading={printing} onPress={() => doPrint(false)} testID="button-print-quotation" />
                <Btn title="مشاركة PDF (واتساب / بريد)" icon="share-2" kind="outline" loading={sharing} onPress={() => doPrint(true)} testID="button-share-quotation" />
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>

      {/* branch / currency picker */}
      <Modal visible={!!pick} transparent animationType="slide" onRequestClose={() => setPick(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '60%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>
              {pick === 'branch' ? 'اختيار الفرع' : 'اختيار العملة'}
            </Text>
            <FlatList
              data={pick === 'branch' ? branches : currencies}
              keyExtractor={(x: any) => String(x.id)}
              renderItem={({ item }: any) => {
                const cur = pick === 'branch' ? branchId === item.id : currency?.id === item.id;
                const isDef = item.isDefault || item.is_default;
                return (
                  <Pressable
                    onPress={() => {
                      if (pick === 'branch') setBranchSel(item.id);
                      else setCurrencySel(item.id);
                      setPick(null);
                    }}
                    style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' })}
                  >
                    <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>
                      {item.nameAr ?? item.code ?? item.id}{isDef ? '  (افتراضي)' : ''}
                    </Text>
                    {cur ? <Feather name="check" size={16} color={c.primary} /> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>

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
              data={customers.filter((x) => !custSearch.trim() || (x.nameAr ?? '').includes(custSearch.trim()))}
              keyExtractor={(x) => String(x.id)}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { setCustomerId(item.id); setShowCustomerPick(false); }}
                  style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between' })}
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
