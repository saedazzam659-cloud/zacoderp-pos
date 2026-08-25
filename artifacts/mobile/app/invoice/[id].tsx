import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
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
import { money, qty as fq, todayISO, showDate } from '@/lib/format';
import { onScan, clearScan } from '@/lib/scanBus';
import { printInvoice, shareInvoicePdf } from '@/lib/print';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Chip, Empty, Field } from '@/components/ui';
import { NumericEntry } from '@/components/NumericEntry';
import { calcInvoiceLine, syncLineDiscount } from '@/lib/invoiceLineCalc';
import { normalizeSearch } from '@/lib/search';

interface Item {
  id: number;
  code?: string;
  nameAr?: string;
  nameEn?: string;
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
  const { companyId, user } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [tab, setTab] = useState<TabKey>('basic');
  const allowedTabs = useMemo(() => TABS.filter((t) =>
    (t.key !== 'returns' || mp('invoice_tab_returns')) &&
    (t.key !== 'details' || mp('invoice_tab_details'))), [mp]);
  useEffect(() => {
    if (!allowedTabs.some((t) => t.key === tab)) setTab(allowedTabs[allowedTabs.length - 1]?.key ?? 'basic');
  }, [allowedTabs, tab]);

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
  // Explicit branch/warehouse/currency selection — defaults applied from the
  // fetched lists on first load (see effects below), user can override.
  const [branchSel, setBranchSel] = useState<number | null>(null);
  const [warehouseSel, setWarehouseSel] = useState<number | null>(null);
  const [currencySel, setCurrencySel] = useState<number | null>(null);
  // نوع الفاتورة: مبسطة تُحفظ بدون رقم ضريبي للعميل؛ ضريبية ترفض الحفظ بدونه.
  const [invoiceKind, setInvoiceKind] = useState<'simplified' | 'tax'>('simplified');
  const [kindTouched, setKindTouched] = useState(false);
  // Generic bottom-sheet list picker (cashbox / bank / branch / warehouse / currency)
  const [pick, setPick] = useState<null | 'cashbox' | 'bank' | 'branch' | 'warehouse' | 'currency'>(null);
  const [custSearch, setCustSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<number | 'all'>('all');
  const [itemUnits, setItemUnits] = useState<Record<number, any[]>>({});

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
     queryFn: () => api<any[]>(`/api/cash-boxes?companyId=${companyId}&onlyUserBranches=1`),
    enabled: !!companyId,
  });
  const banksQ = useQuery({
    queryKey: ['bank-accounts', companyId],
     queryFn: () => api<any[]>(`/api/bank-accounts?companyId=${companyId}&onlyUserBranches=1`),
    enabled: !!companyId,
  });
  const branchesQ = useQuery({
    queryKey: ['branches', companyId],
     queryFn: () => api<any[]>(`/api/org/branches?companyId=${companyId}&onlyUserBranches=1`),
    enabled: !!companyId,
    retry: false,
  });
  const warehousesQ = useQuery({
    queryKey: ['warehouses', companyId],
     queryFn: () => api<any[]>(`/api/inventory/warehouses?companyId=${companyId}&onlyUserBranches=1`),
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
    if (d.branchId) setBranchSel(d.branchId);
    const firstWh = (Array.isArray(d.lines) ? d.lines : []).find((l: any) => l.warehouseId)?.warehouseId;
    if (firstWh) setWarehouseSel(firstWh);
    const ls: CartLine[] = (Array.isArray(d.lines) ? d.lines : []).map((l: any) => ({
      itemId: l.itemId,
      name: l.itemName ?? l.item?.nameAr ?? `صنف ${l.itemId}`,
      qty: parseFloat(l.qty ?? l.quantity ?? 1) || 1,
      unitPrice: parseFloat(l.unitPrice ?? 0) || 0,
      vatRate: parseFloat(l.vatRate ?? 15) || 0,
      freeQty: parseFloat(l.freeQty ?? 0) || 0,
      discount: parseFloat(l.discount ?? 0) || 0,
      discountAmount: parseFloat(l.discountAmount ?? 0) || 0,
      unitId: l.unitId ?? undefined,
      unitName: l.unit ?? l.unitName ?? undefined,
      conversionFactor: parseFloat(l.conversionFactor ?? 1) || 1,
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

  // default branch: user's own branch first, then company's default/first.
  // `/api/org/branches` is already scoped server-side to the branches the
  // user may access, so the picker simply shows everything returned.
  const branches = Array.isArray(branchesQ.data) ? branchesQ.data : [];
  const defaultBranchId =
    loadedDoc?.branchId ??
    (user?.branchIds?.length ? user.branchIds[0] : null) ??
    (branches.find((b: any) => b.isDefault || b.is_default)?.id ?? branches[0]?.id ?? null);
  const branchId = branchSel ?? defaultBranchId;

  // default warehouse for stock lines
  const warehouses = Array.isArray(warehousesQ.data) ? warehousesQ.data : [];
  const defaultWarehouseId =
    (warehouses.find((w: any) => w.isDefault || w.is_default)?.id ?? warehouses[0]?.id ?? null);
  const warehouseId = warehouseSel ?? defaultWarehouseId;

  // default currency: company default → SAR → first
  const currencies = Array.isArray(currenciesQ.data) ? currenciesQ.data : [];
  const defaultCurrency =
    currencies.find((x: any) => x.isDefault || x.is_default) ??
    currencies.find((x: any) => String(x.code ?? '').toUpperCase() === 'SAR') ??
    currencies[0] ?? null;
  const currency = currencies.find((x: any) => x.id === currencySel) ?? defaultCurrency;

  // default cash box on open (نقدي): default-flagged box → first
  useEffect(() => {
    if (!cashBoxId && cashBoxes.length > 0 && !loadedDoc) {
      setCashBoxId((cashBoxes.find((b: any) => b.isDefault || b.is_default) ?? cashBoxes[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashBoxes.length]);

  // نوع الفاتورة يتبع الرقم الضريبي للعميل تلقائياً ما لم يختَر المستخدم يدوياً
  // (يعتمد على vatNumber نفسه حتى لو وصلت بيانات العملاء بعد اختيار العميل)
  useEffect(() => {
    if (!kindTouched) setInvoiceKind(customer?.vatNumber ? 'tax' : 'simplified');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, customer?.vatNumber]);

  // ترطيب العملة من مستند محفوظ — حتى لا يستبدل التعديل عملة الفاتورة الأصلية
  useEffect(() => {
    if (!loadedDoc?.currencyCode || currencySel != null || !currencies.length) return;
    const m = currencies.find((x: any) => String(x.code ?? '').toUpperCase() === String(loadedDoc.currencyCode).toUpperCase());
    if (m) setCurrencySel(m.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDoc?.currencyCode, currencies.length]);

  // groups for chips
  const groups = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of items) if (it.group?.id) m.set(it.group.id, it.group.nameAr ?? '');
    return [...m.entries()].map(([gid, name]) => ({ id: gid, name }));
  }, [items]);

  const visibleItems = useMemo(() => {
    let list = items;
    if (activeGroup !== 'all') list = list.filter((i) => i.group?.id === activeGroup);
    const s = normalizeSearch(itemSearch);
    if (s) list = list.filter((i) =>
      normalizeSearch(i.nameAr).includes(s) ||
      normalizeSearch(i.nameEn).includes(s) ||
      normalizeSearch(i.code).includes(s) ||
      normalizeSearch(i.barcode).includes(s));
    return list.slice(0, 100);
  }, [items, activeGroup, itemSearch]);

  // totals — mirrors web logic (VAT add vs price-inclusive)
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
          freeQty: 0, discount: 0, discountAmount: 0,
          unitId: it.unit?.id, conversionFactor: 1,
        },
      ];
    });
  };

  const setLineQty = (itemId: number, q: number) => {
    setLines((prev) => (q <= 0 ? prev.filter((l) => l.itemId !== itemId) : prev.map((l) => (l.itemId === itemId ? { ...l, qty: q } : l))));
  };

  // أسعار حية: عند كل فتح/عودة لهذه الشاشة نعيد جلب الأصناف من السيرفر
  // فتظهر تعديلات الأسعار التي تمت من الويب فوراً دون إعادة تشغيل التطبيق.
  useFocusEffect(
    React.useCallback(() => {
      if (companyId) itemsQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [companyId]),
  );

  // تعديل سعر البيع لسطر — متاح فقط لمن يملك صلاحية invoice_edit_price
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
  // The inventory endpoint is the same item-unit contract used by the web
  // sales form: each option supplies unitId, conversionFactor and salePrice.
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

  const openScanner = () => {
    onScan((code) => {
      const it = items.find((i) => (i.barcode ?? '') === code || i.code === code);
      if (it) addItem(it);
      else notify('غير موجود', `لا يوجد صنف بالباركود ${code}`);
    });
    router.push('/scan');
  };
  useEffect(() => () => clearScan(), []);

  const buildBody = (mobileSaveMode: 'draft' | 'issue' = 'draft') => {
    const bodyLines = lines.map((l) => {
      const gross = calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount').total;
      const it = items.find((i) => i.id === l.itemId);
      return {
        itemId: l.itemId,
        itemName: l.name || it?.nameAr || `صنف ${l.itemId}`,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
        freeQty: l.freeQty,
        discount: l.discount,
        discountAmount: l.discountAmount,
        // mirrors the web form: line total is the entered (gross) amount
        lineTotal: +gross.toFixed(2),
        warehouseId: warehouseId ?? undefined,
        unitId: l.unitId ?? it?.unit?.id ?? undefined,
        conversionFactor: l.conversionFactor,
      };
    });
    return {
      companyId,
      invoiceDate,
      customerId,
      branchId,
      currencyCode: currency?.code ?? 'SAR',
      exchangeRate: String(currency?.exchangeRate ?? currency?.rate ?? '1'),
      paymentType,
      cashBoxId: paymentType === 'cash' ? cashBoxId : null,
      bankAccountId: paymentType === 'bank' ? bankAccountId : null,
      priceIncludesVat,
      subtotal: +totals.subtotal.toFixed(2),
      vatAmount: +totals.vat.toFixed(2),
      discountAmount: 0,
      totalAmount: +totals.total.toFixed(2),
      notes: notes || undefined,
      mobileSaveMode,
      lines: bodyLines,
    };
  };

  const validate = (): string => {
    if (!lines.length) return 'أضف صنفاً واحداً على الأقل';
    if (!customerId) return 'اختر العميل (للبيع النقدي اختر «عميل نقدي»)';
    if (!branchId) return 'لا يوجد فرع معرّف لحسابك — تواصل مع مدير النظام';
    if (paymentType === 'cash' && !cashBoxId && cashBoxes.length > 0) return 'اختر الخزنة';
    if (paymentType === 'bank' && !bankAccountId) return 'اختر الحساب البنكي';
    // فاتورة ضريبية تتطلب رقم ضريبي للعميل — نرفض الحفظ بدونه (المبسطة تُحفظ بدونه)
    if (invoiceKind === 'tax' && !String(customer?.vatNumber ?? '').trim())
      return 'الفاتورة الضريبية تتطلب عميلاً له رقم ضريبي — أدخل الرقم الضريبي للعميل أو اختر فاتورة مبسطة';
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
        const created = await api<any>('/api/sales/sales-invoices', {
          method: 'POST',
          body: buildBody(thenPost ? 'issue' : 'draft'),
        });
        // أوف لاين: دخلت الفاتورة صندوق الصادر — لا يوجد معرف بعد، فنتخطى
        // خطوة الترحيل ونعود؛ ستُزامن (وتُرحّل من الويب) عند عودة الاتصال.
        if (created?.offline) {
          qc.invalidateQueries({ queryKey: ['sales-invoices', companyId] });
          qc.invalidateQueries({ queryKey: ['outbox-invoices', companyId] });
          notify('تم الحفظ محلياً', 'لا يوجد اتصال — حُفظت الفاتورة على الجهاز وستُزامن تلقائياً عند عودة الإنترنت');
          router.back();
          return;
        }
        docId = created?.id ?? created?.invoice?.id;
        setLoadedDoc(created?.invoice ?? created);
      } else {
        await api(`/api/sales/sales-invoices/${docId}`, {
          method: 'PUT',
          body: buildBody(thenPost ? 'issue' : 'draft'),
        });
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

  // حذف فاتورة (مسودة فقط — السيرفر يرفض المرحّلة/المعتمدة من زاتكا)
  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    const go = async () => {
      setDeleting(true);
      try {
        await api(`/api/sales/sales-invoices/${invoiceId}?companyId=${companyId}`, { method: 'DELETE' });
        qc.invalidateQueries({ queryKey: ['sales-invoices', companyId] });
        notify('تم', 'تم حذف الفاتورة');
        router.back();
      } catch (e: any) {
        notify('تعذّر الحذف', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setDeleting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('حذف الفاتورة', 'سيتم حذف الفاتورة نهائياً. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'حذف', style: 'destructive', onPress: go },
    ]);
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
        setLoadedDoc((current: any) => current ? { ...current, status: 'draft' } : current);
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

  // إرسال الفاتورة عبر واتساب — يفتح محادثة رقم العميل (أو بدون رقم) بنص ملخص
  // الفاتورة؛ لمشاركة PDF نموذج 14 نفسه يستخدم زر «مشاركة PDF».
  const sendWhatsApp = async () => {
    if (!loadedDoc) return;
    const phone = String(customer?.phone ?? customer?.mobile ?? '').replace(/[^0-9]/g, '');
    const intl = phone.startsWith('0') ? `966${phone.slice(1)}` : phone;
    const msg =
      `فاتورة ${invoiceKind === 'tax' ? 'ضريبية' : 'مبسطة'} رقم ${loadedDoc.docNumber ?? loadedDoc.id}\n` +
      `التاريخ: ${String(loadedDoc.invoiceDate ?? '').slice(0, 10)}\n` +
      `العميل: ${customer?.nameAr ?? '—'}\n` +
      `الإجمالي شامل الضريبة: ${money(loadedDoc.totalAmount ?? totals.total)} ريال\n` +
      `${user?.company?.nameAr ?? ''}`;
    const url = `https://wa.me/${intl ? intl : ''}?text=${encodeURIComponent(msg)}`;
    try { await Linking.openURL(url); } catch { notify('خطأ', 'تعذّر فتح واتساب'); }
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
          {allowedTabs.map((tb, i) => (
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
              <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>طريقة الدفع</Text>
              <Seg
                options={[{ v: 'cash', l: 'نقدي' }, { v: 'bank', l: 'بنك/شبكة' }, { v: 'credit', l: 'آجل' }]}
                value={paymentType}
                onChange={setPaymentType}
              />
              {paymentType === 'cash' && cashBoxes.length > 0 ? (
                <PickRow
                  label="الخزنة"
                  value={cashBoxes.find((b) => b.id === cashBoxId)?.nameAr ?? 'اختر'}
                  onPress={() => setPick('cashbox')}
                  testID="pick-cashbox"
                />
              ) : null}
              {paymentType === 'bank' ? (
                <PickRow
                  label="الحساب البنكي"
                  value={banks.find((b) => b.id === bankAccountId)?.nameAr ?? 'اختر'}
                  onPress={() => setPick('bank')}
                  testID="pick-bank"
                />
              ) : null}
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
                label="المخزن"
                value={warehouses.find((w: any) => w.id === warehouseId)?.nameAr ?? '—'}
                onPress={() => { if (warehouses.length > 1) setPick('warehouse'); }}
                testID="pick-warehouse"
              />
              <PickRow
                label="العملة"
                value={currency ? `${currency.nameAr ?? currency.code}${(currency.isDefault || currency.is_default) ? ' (افتراضية)' : ''}` : 'ريال سعودي'}
                onPress={() => { if (currencies.length > 1) setPick('currency'); }}
                testID="pick-currency"
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
              {/* نوع الفاتورة: مبسطة (بدون رقم ضريبي) / ضريبية (رقم ضريبي إلزامي) */}
              <Seg
                options={[{ v: 'simplified', l: 'فاتورة مبسطة' }, { v: 'tax', l: 'فاتورة ضريبية' }]}
                value={invoiceKind}
                onChange={(v: any) => { setInvoiceKind(v); setKindTouched(true); }}
              />
              {invoiceKind === 'tax' && !String(customer?.vatNumber ?? '').trim() ? (
                <Text style={{ fontSize: 12, color: c.destructive, textAlign: 'right' }}>
                  الفاتورة الضريبية تتطلب رقماً ضريبياً للعميل — لن يتم الحفظ بدونه.
                </Text>
              ) : null}
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
                        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'flex-start', gap: 7 }}>
                          {!readOnly && mp('invoice_edit_price') ? (
                            <NumericEntry
                              testID={`input-cart-price-${item.id}`}
                              value={inCart.unitPrice}
                              onChangeValue={(v) => setLinePrice(item.id, v)}
                              style={{ minWidth: 64, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 6, textAlign: 'center', fontSize: 13, color: c.foreground, backgroundColor: c.background }}
                            />
                          ) : null}
                          {!readOnly ? (
                            <Pressable onPress={() => setLineQty(item.id, inCart.qty + 1)} style={{ backgroundColor: c.primary, borderRadius: 8, padding: 6 }}>
                              <Feather name="plus" size={14} color="#fff" />
                            </Pressable>
                          ) : null}
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
                          {!readOnly ? (
                            <Pressable onPress={() => setLineQty(item.id, inCart.qty - 1)} style={{ backgroundColor: c.muted, borderRadius: 8, padding: 6 }}>
                              <Feather name="minus" size={14} color={c.foreground} />
                            </Pressable>
                          ) : null}
                        </View>
                        {readOnly || mp('invoice_free_qty') || mp('invoice_discount') || mp('invoice_unit_selection') ? (
                          <View style={{ gap: 6 }}>
                            <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 6 }}>
                              {readOnly || mp('invoice_free_qty') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>مجاني</Text>
                                  {readOnly ? (
                                    <Text style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 5, textAlign: 'center', fontSize: 12, color: c.foreground }}>{fq(inCart.freeQty)}</Text>
                                  ) : (
                                    <NumericEntry testID={`input-cart-free-qty-${item.id}`} value={inCart.freeQty} emptyValue={0}
                                      onChangeValue={(v) => setLineField(item.id, 'freeQty', v)}
                                      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                  )}
                                </View>
                              ) : null}
                              {readOnly || mp('invoice_discount') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم %</Text>
                                  {readOnly ? (
                                    <Text style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 5, textAlign: 'center', fontSize: 12, color: c.foreground }}>{fq(inCart.discount)}%</Text>
                                  ) : (
                                    <NumericEntry testID={`input-cart-discount-${item.id}`} value={inCart.discount} emptyValue={0}
                                      onChangeValue={(v) => setLineField(item.id, 'discount', v)}
                                      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                  )}
                                </View>
                              ) : null}
                              {readOnly || mp('invoice_discount') ? (
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم قيمة</Text>
                                  {readOnly ? (
                                    <Text style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 5, textAlign: 'center', fontSize: 12, color: c.foreground }}>{money(inCart.discountAmount)}</Text>
                                  ) : (
                                    <NumericEntry testID={`input-cart-discount-amount-${item.id}`} value={inCart.discountAmount} emptyValue={0}
                                      onChangeValue={(v) => setLineField(item.id, 'discountAmount', v)}
                                      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                                  )}
                                </View>
                              ) : null}
                            </View>
                            {!readOnly && mp('invoice_unit_selection') ? (
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

            {/* cart footer */}
            <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>{lines.length} صنف · الإجمالي شامل الضريبة</Text>
                <Text style={{ color: c.primary, fontSize: 17, fontFamily: 'Inter_700Bold' }}>{money(totals.total)}</Text>
              </View>
              {mp('invoice_tab_details') ? (
                <Btn title="التالي: التفاصيل والحفظ" onPress={() => setTab('details')} icon="arrow-left" small />
              ) : (
                <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
                  {mp('invoice_save_issue') && mp('invoice_post') ? <View style={{ flex: 1 }}><Btn title="حفظ وإصدار" onPress={() => save(true)} loading={posting} icon="check-circle" small testID="button-items-save-post" /></View> : null}
                  {mp('invoice_save_draft') ? <View style={{ flex: 1 }}><Btn title="حفظ مسودة" onPress={() => save(false)} loading={saving} kind="outline" small testID="button-items-save-draft" /></View> : null}
                </View>
              )}
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
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
            {!loadedDoc ? (
              <Card><Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 14 }}>احفظ الفاتورة أولاً لإنشاء مرتجع منها.</Text></Card>
            ) : (
              <>
                <Card>
                  <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 14, lineHeight: 22 }}>
                    يُنشأ المرتجع من أصناف هذه الفاتورة، ويظهر تلقائياً في شاشة «مرتجع المبيعات».
                  </Text>
                </Card>
                <Btn
                  title="إنشاء مرتجع من هذه الفاتورة"
                  icon="corner-up-right"
                  onPress={() => router.push({ pathname: '/return/new', params: { invoiceId: String(loadedDoc.id) } } as any)}
                  testID="button-create-return"
                />
                <Btn title="عرض كل المرتجعات" icon="list" kind="outline" onPress={() => router.push('/returns' as any)} />
              </>
            )}
          </ScrollView>
        )}

        {tab === 'details' && (
          <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 10 }}>
              {lines.map((l) => (
                <Card key={l.itemId} style={{ gap: 11, borderColor: c.border }}>
                  <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 15, fontFamily: 'Inter_600SemiBold', color: c.foreground, textAlign: 'right' }}>{l.name}</Text>
                      <Text style={{ fontSize: 11, color: c.mutedForeground, textAlign: 'right' }}>
                        {l.unitName ?? 'الوحدة الأساسية'}
                      </Text>
                    </View>
                    <View style={{ backgroundColor: c.secondary, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 }}>
                      <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', color: c.primary }}>
                        {money(calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount').total)}
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>الكمية</Text>
                      {readOnly ? (
                        <View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.background }}>
                          <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{fq(l.qty)}</Text>
                        </View>
                      ) : (
                        <NumericEntry
                          testID={`input-line-qty-${l.itemId}`}
                          value={l.qty}
                          blankWhenZero={false}
                          blankWhenOne
                          onChangeValue={(v) => setLineQty(l.itemId, v)}
                          style={{ minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 8, textAlign: 'center', fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground, backgroundColor: c.background }}
                        />
                      )}
                    </View>
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>سعر الوحدة</Text>
                      {!readOnly && mp('invoice_edit_price') ? (
                        <NumericEntry
                          testID={`input-line-price-${l.itemId}`}
                          value={l.unitPrice}
                          blankWhenZero={false}
                          onChangeValue={(v) => setLinePrice(l.itemId, v)}
                          style={{ minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 8, textAlign: 'center', fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground, backgroundColor: c.background }}
                        />
                      ) : (
                        <View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.background }}>
                          <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{money(l.unitPrice)}</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {readOnly || mp('invoice_free_qty') || mp('invoice_discount') ? (
                    <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 8 }}>
                      {readOnly || mp('invoice_free_qty') ? (
                        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                          <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>مجاني</Text>
                          {readOnly ? (
                            <View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.background }}>
                              <Text style={{ fontSize: 13, color: c.foreground }}>{fq(l.freeQty)}</Text>
                            </View>
                          ) : (
                            <NumericEntry testID={`input-line-free-qty-${l.itemId}`} value={l.freeQty} emptyValue={0}
                              onChangeValue={(v) => setLineField(l.itemId, 'freeQty', v)}
                              style={{ minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 6, textAlign: 'center', fontSize: 13, color: c.foreground, backgroundColor: c.background }} />
                          )}
                        </View>
                      ) : null}
                      {readOnly || mp('invoice_discount') ? (
                        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                          <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>خصم %</Text>
                          {readOnly ? (
                            <View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.background }}>
                              <Text style={{ fontSize: 13, color: c.foreground }}>{fq(l.discount)}%</Text>
                            </View>
                          ) : (
                            <NumericEntry testID={`input-line-discount-${l.itemId}`} value={l.discount} emptyValue={0}
                              onChangeValue={(v) => setLineField(l.itemId, 'discount', v)}
                              style={{ minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 6, textAlign: 'center', fontSize: 13, color: c.foreground, backgroundColor: c.background }} />
                          )}
                        </View>
                      ) : null}
                      {readOnly || mp('invoice_discount') ? (
                        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                          <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>خصم مبلغ</Text>
                          {readOnly ? (
                            <View style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.background }}>
                              <Text style={{ fontSize: 13, color: c.foreground }}>{money(l.discountAmount)}</Text>
                            </View>
                          ) : (
                            <NumericEntry testID={`input-line-discount-amount-${l.itemId}`} value={l.discountAmount} emptyValue={0}
                              onChangeValue={(v) => setLineField(l.itemId, 'discountAmount', v)}
                              style={{ minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 6, textAlign: 'center', fontSize: 13, color: c.foreground, backgroundColor: c.background }} />
                          )}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                  {!readOnly && mp('invoice_unit_selection') ? (
                    <Pressable onPress={() => selectNextUnit(l)} testID={`button-line-unit-${l.itemId}`} style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.muted }}>
                      <Text style={{ color: c.foreground, fontSize: 12, fontFamily: 'Inter_500Medium' }}>الوحدة: {l.unitName ?? 'الأساسية'}</Text>
                      <Text style={{ color: c.primary, fontSize: 11 }}>اضغط للتغيير</Text>
                    </Pressable>
                  ) : null}
                </Card>
              ))}
              {!lines.length ? <Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا توجد أصناف — ارجع لتبويب الأصناف</Text> : null}
            </View>
            <Card style={{ gap: 10 }}>
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
              isNew && !mp('invoice_create') ? (
                <Card><Text style={{ textAlign: 'right', color: c.destructive }}>ليست لديك صلاحية إنشاء فاتورة من التطبيق — تواصل مع مدير النظام.</Text></Card>
              ) : !isNew && !mp('invoice_edit') ? (
                <View style={{ gap: 10 }}>
                  <Card><Text style={{ textAlign: 'right', color: c.destructive }}>ليست لديك صلاحية تعديل الفواتير من التطبيق — تواصل مع مدير النظام.</Text></Card>
                  {mp('invoice_delete') ? (
                    <Btn title="حذف الفاتورة" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-invoice" />
                  ) : null}
                </View>
              ) : (
              <View style={{ gap: 10 }}>
                {mp('invoice_save_issue') && mp('invoice_post') ? <Btn title="حفظ وإصدار الفاتورة" onPress={() => save(true)} loading={posting} icon="check-circle" testID="button-save-post" /> : null}
                {mp('invoice_save_draft') ? <Btn title="حفظ كمسودة" onPress={() => save(false)} loading={saving} kind="outline" testID="button-save-draft" /> : null}
                {!isNew && mp('invoice_delete') ? (
                  <Btn title="حذف الفاتورة" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-invoice" />
                ) : null}
              </View>
              )
            ) : (
              <View style={{ gap: 10 }}>
                <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>هذه الفاتورة صادرة — للعرض فقط.</Text></Card>
                {mp('invoice_print') ? (
                  <>
                    <Btn title="طباعة الفاتورة (نموذج 14)" icon="printer" loading={printing} onPress={() => doPrint(false)} testID="button-print" />
                    <Btn title="مشاركة PDF (واتساب / بريد)" icon="share-2" kind="outline" loading={sharing} onPress={() => doPrint(true)} testID="button-share" />
                  </>
                ) : null}
                {mp('invoice_whatsapp') ? (
                  <Btn title="إرسال عبر واتساب" icon="message-circle" kind="outline" onPress={sendWhatsApp} testID="button-whatsapp" />
                ) : null}
                {mp('invoice_unpost') ? (
                  <Btn title="فك ترحيل الفاتورة" icon="rotate-ccw" kind="destructive" loading={unposting} onPress={doUnpost} testID="button-unpost" />
                ) : null}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      {/* generic list picker (خزنة / بنك / فرع / مخزن / عملة) */}
      <Modal visible={!!pick} transparent animationType="slide" onRequestClose={() => setPick(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '60%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>
              {pick === 'cashbox' ? 'اختيار الخزنة' : pick === 'bank' ? 'اختيار الحساب البنكي' : pick === 'branch' ? 'اختيار الفرع' : pick === 'warehouse' ? 'اختيار المخزن' : 'اختيار العملة'}
            </Text>
            <FlatList
              data={pick === 'cashbox' ? cashBoxes : pick === 'bank' ? banks : pick === 'branch' ? branches : pick === 'warehouse' ? warehouses : currencies}
              keyExtractor={(x: any) => String(x.id)}
              renderItem={({ item }: any) => {
                const cur =
                  pick === 'cashbox' ? cashBoxId === item.id :
                  pick === 'bank' ? bankAccountId === item.id :
                  pick === 'branch' ? branchId === item.id :
                  pick === 'warehouse' ? warehouseId === item.id :
                  currency?.id === item.id;
                const isDef = item.isDefault || item.is_default;
                return (
                  <Pressable
                    onPress={() => {
                      if (pick === 'cashbox') setCashBoxId(item.id);
                      else if (pick === 'bank') setBankAccountId(item.id);
                      else if (pick === 'branch') setBranchSel(item.id);
                      else if (pick === 'warehouse') setWarehouseSel(item.id);
                      else setCurrencySel(item.id);
                      setPick(null);
                    }}
                    style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: StyleShim, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' })}
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
              data={[{ id: null as any, nameAr: 'بدون عميل (نقدي)' }, ...customers.filter((x) => {
                const s = normalizeSearch(custSearch);
                return !s || normalizeSearch(x.nameAr).includes(s) || normalizeSearch(x.nameEn).includes(s) || normalizeSearch(x.code).includes(s);
              })]}
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
