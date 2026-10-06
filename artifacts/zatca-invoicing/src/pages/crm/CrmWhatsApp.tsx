import { useMemo, useRef, useState } from "react";
import {
  useConvertWhatsAppContact,
  useCreateWhatsAppCampaign,
  useCreateWhatsAppContact,
  useDeleteWhatsAppCampaign,
  useDeleteWhatsAppContact,
  useGetWhatsAppCampaign,
  useImportWhatsAppContacts,
  getGetWhatsAppCampaignQueryKey,
  getListWhatsAppCampaignsQueryKey,
  getListWhatsAppContactsQueryKey,
  useListWhatsAppCampaigns,
  useListWhatsAppContacts,
  useUpdateWhatsAppCampaignRecipient,
  useUpdateWhatsAppContact,
  type WhatsAppContact,
  type WhatsAppContactImportRow,
  type WhatsAppCampaign,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ContactRound,
  FileSpreadsheet,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import * as XLSX from "xlsx";

type Tab = "contacts" | "campaigns";
type ContactForm = { name: string; phone: string; notes: string };
type ImportSummary = { created: number; duplicates: number; revived: number; invalid: number };

const EMPTY_CONTACT: ContactForm = { name: "", phone: "", notes: "" };
const panelClass = "rounded-2xl border border-[#dce9e4] bg-white shadow-[0_8px_28px_rgba(28,79,62,0.045)]";
const inputClass = "h-10 rounded-xl border-[#dce8e3] bg-[#fbfdfc] text-sm shadow-none focus-visible:ring-[#15967d]";

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return "تعذر إكمال العملية. حاول مرة أخرى.";
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function normalizeHeader(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

function parseImportRows(matrix: unknown[][]): WhatsAppContactImportRow[] {
  if (matrix.length < 2) return [];
  const first = matrix[0].map(normalizeHeader);
  const findIndex = (aliases: string[]) => first.findIndex((header) => aliases.includes(header));
  const nameIndex = findIndex(["name", "fullname", "contactname", "الاسم", "الاسمكاملا", "اسمالعميل"]);
  const phoneIndex = findIndex(["phone", "phonenumber", "mobile", "mobilenumber", "الهاتف", "رقمالهاتف", "الجوال", "رقمالجوال"]);
  const notesIndex = findIndex(["notes", "note", "ملاحظات", "ملاحظة"]);
  const hasHeader = nameIndex >= 0 || phoneIndex >= 0;
  const rows = hasHeader ? matrix.slice(1) : matrix;
  const nameCol = hasHeader ? nameIndex : 0;
  const phoneCol = hasHeader ? phoneIndex : 1;
  const noteCol = hasHeader ? notesIndex : 2;
  return rows.filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row) => ({
    name: String(row[nameCol] ?? "").trim(),
    phone: String(row[phoneCol] ?? "").trim(),
    notes: noteCol >= 0 ? String(row[noteCol] ?? "").trim() || null : null,
  }));
}

function parsePastedContacts(value: string): WhatsAppContactImportRow[] {
  const rows: WhatsAppContactImportRow[] = [];
  const isPhone = (cell: string) => (cell.match(/[0-9٠-٩۰-۹]/g) ?? []).length >= 7;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = (line.includes("\t") ? line.split("\t")
      : line.includes(";") ? line.split(";")
      : line.includes("|") ? line.split("|")
      : line.includes(",") ? line.split(",")
      : [line]).map((cell) => cell.trim());
    const first = normalizeHeader(cells[0]);
    if (["name", "fullname", "contactname", "الاسم", "الاسمكاملا", "اسمالعميل"].includes(first)) continue;

    const phoneIndex = cells.findIndex(isPhone);
    if (phoneIndex > 0) {
      rows.push({
        name: cells.slice(0, phoneIndex).join(" ").trim(),
        phone: cells[phoneIndex],
        notes: cells.slice(phoneIndex + 1).join(" ").trim() || null,
      });
      continue;
    }
    const phoneCells = cells.filter(isPhone);
    if (phoneCells.length > 0) {
      for (const phone of phoneCells) rows.push({ name: "", phone, notes: null });
    } else {
      rows.push({ name: "", phone: line, notes: null });
    }
  }
  return rows.map((row, index) => ({
    ...row,
    name: row.name || `جهة ${index + 1}`,
  }));
}

function waMeNumber(phone: string) {
  let digits = phone
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

export default function CrmWhatsApp() {
  const { user } = useAuth() as any;
  const companyId = Number(user?.companyId);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("contacts");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [contactModal, setContactModal] = useState(false);
  const [editing, setEditing] = useState<WhatsAppContact | null>(null);
  const [contactForm, setContactForm] = useState<ContactForm>(EMPTY_CONTACT);
  const [importModal, setImportModal] = useState(false);
  const [importRows, setImportRows] = useState<WhatsAppContactImportRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [importTruncatedRows, setImportTruncatedRows] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [campaignModal, setCampaignModal] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [campaignMessage, setCampaignMessage] = useState("");
  const [activeCampaign, setActiveCampaign] = useState<WhatsAppCampaign | null>(null);
  const [contactToDelete, setContactToDelete] = useState<WhatsAppContact | null>(null);
  const [campaignToDelete, setCampaignToDelete] = useState<WhatsAppCampaign | null>(null);
  const [convertingId, setConvertingId] = useState<number | null>(null);

  const contactKey = getListWhatsAppContactsQueryKey({ companyId });
  const campaignKey = getListWhatsAppCampaignsQueryKey({ companyId });
  const contactsQuery = useListWhatsAppContacts({ companyId }, {
    query: { enabled: !!companyId, queryKey: contactKey },
  });
  const campaignsQuery = useListWhatsAppCampaigns({ companyId }, {
    query: { enabled: !!companyId, queryKey: campaignKey },
  });
  const contacts = (contactsQuery.data ?? []) as WhatsAppContact[];
  const campaigns = (campaignsQuery.data ?? []) as WhatsAppCampaign[];
  const campaignDetailQuery = useGetWhatsAppCampaign(activeCampaign?.id ?? 0, {
    query: {
      enabled: !!activeCampaign?.id,
      queryKey: getGetWhatsAppCampaignQueryKey(activeCampaign?.id ?? 0),
    },
  });
  const campaignDetail = campaignDetailQuery.data;

  const createContact = useCreateWhatsAppContact();
  const updateContact = useUpdateWhatsAppContact();
  const deleteContact = useDeleteWhatsAppContact();
  const importContacts = useImportWhatsAppContacts();
  const convertContact = useConvertWhatsAppContact();
  const createCampaign = useCreateWhatsAppCampaign();
  const deleteCampaign = useDeleteWhatsAppCampaign();
  const updateRecipient = useUpdateWhatsAppCampaignRecipient();

  const filteredContacts = useMemo(() => contacts.filter((contact) => {
    const query = search.trim().toLowerCase();
    return !query || contact.name.toLowerCase().includes(query) || contact.phone.toLowerCase().includes(query);
  }), [contacts, search]);
  const filteredCampaigns = useMemo(() => campaigns.filter((campaign) => {
    const query = search.trim().toLowerCase();
    return !query || campaign.name.toLowerCase().includes(query) || campaign.message.toLowerCase().includes(query);
  }), [campaigns, search]);
  const allVisibleSelected = filteredContacts.length > 0 && filteredContacts.every((contact) => selected.includes(contact.id));
  const pending = createContact.isPending || updateContact.isPending;

  function refreshContacts() {
    void queryClient.invalidateQueries({ queryKey: contactKey });
  }
  function refreshCampaigns() {
    void queryClient.invalidateQueries({ queryKey: campaignKey });
  }
  function openCreateContact() {
    setEditing(null);
    setContactForm(EMPTY_CONTACT);
    setContactModal(true);
  }
  function openEditContact(contact: WhatsAppContact) {
    setEditing(contact);
    setContactForm({ name: contact.name, phone: contact.phone, notes: contact.notes ?? "" });
    setContactModal(true);
  }
  function openImportModal() {
    setImportModal(true);
    setImportRows([]);
    setImportFileName("");
    setPasteText("");
    setImportSummary(null);
    setImportTruncatedRows(0);
  }
  function saveContact() {
    if (!companyId || !contactForm.name.trim() || !contactForm.phone.trim()) return;
    const data = {
      companyId,
      name: contactForm.name.trim(),
      phone: contactForm.phone.trim(),
      notes: contactForm.notes.trim() || null,
    };
    const onSuccess = () => {
      refreshContacts();
      setContactModal(false);
      setEditing(null);
      toast({ title: editing ? "تم تحديث جهة الاتصال" : "تمت إضافة جهة الاتصال" });
    };
    const onError = (error: unknown) => toast({ title: "تعذر حفظ جهة الاتصال", description: errorText(error), variant: "destructive" });
    if (editing) updateContact.mutate({ contactId: editing.id, data }, { onSuccess, onError });
    else createContact.mutate({ data }, { onSuccess, onError });
  }
  function toggleContact(id: number) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function toggleAllVisible() {
    setSelected((current) => allVisibleSelected
      ? current.filter((id) => !filteredContacts.some((contact) => contact.id === id))
      : [...new Set([...current, ...filteredContacts.map((contact) => contact.id)])]);
  }
  function openCampaignComposer() {
    if (selected.length < 1) return;
    setCampaignName("");
    setCampaignMessage("");
    setCampaignModal(true);
  }
  function saveCampaign() {
    if (!companyId || !campaignName.trim() || !campaignMessage.trim() || !selected.length) return;
    createCampaign.mutate({ data: {
      companyId,
      name: campaignName.trim(),
      message: campaignMessage.trim(),
      contactIds: selected.slice(0, 1000),
    } }, {
      onSuccess: (campaign) => {
        refreshCampaigns();
        setCampaignModal(false);
        setSelected([]);
        setTab("campaigns");
        setActiveCampaign(campaign);
        toast({ title: "تم حفظ الحملة", description: `${campaign.totalRecipients} مستلم محفوظ` });
      },
      onError: (error) => toast({ title: "تعذر حفظ الحملة", description: errorText(error), variant: "destructive" }),
    });
  }
  async function readImportFile(file?: File) {
    if (!file) return;
    setImportRows([]);
    setImportSummary(null);
    setImportTruncatedRows(0);
    setImportFileName(file.name);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
      const rows = parseImportRows(matrix);
      if (!rows.length) {
        toast({ title: "لم نعثر على صفوف للاستيراد", description: "استخدم أعمدة الاسم ورقم الهاتف.", variant: "destructive" });
        return;
      }
      setImportRows(rows.slice(0, 1000));
      setImportTruncatedRows(Math.max(0, rows.length - 1000));
      setImportFileName(file.name);
      setImportSummary(null);
    } catch {
      toast({ title: "تعذر قراءة الملف", description: "اختر ملف Excel أو CSV صالحًا.", variant: "destructive" });
    }
  }
  function preparePasteImport() {
    const rows = parsePastedContacts(pasteText);
    if (!rows.length) {
      toast({ title: "لا توجد أرقام جاهزة", description: "الصق رقمًا في كل سطر أو الاسم ثم الرقم.", variant: "destructive" });
      return;
    }
    setImportRows(rows.slice(0, 1000));
    setImportTruncatedRows(Math.max(0, rows.length - 1000));
    setImportFileName(`دفعة ملصقة · ${Math.min(rows.length, 1000)} رقم`);
    setImportSummary(null);
  }
  function runImport() {
    if (!companyId || !importRows.length) return;
    setImportBusy(true);
    importContacts.mutate({ data: { companyId, contacts: importRows.slice(0, 1000) } }, {
      onSuccess: (result) => {
        const summary = { created: result.created, duplicates: result.duplicates, revived: result.revived, invalid: result.invalid };
        setImportSummary(summary);
        refreshContacts();
        setSelected([]);
        toast({ title: "اكتمل الاستيراد", description: `${summary.created} جديد · ${summary.duplicates} مكرر · ${summary.revived} مستعاد · ${summary.invalid} غير صالح` });
      },
      onError: (error) => toast({ title: "تعذر استيراد جهات الاتصال", description: errorText(error), variant: "destructive" }),
      onSettled: () => setImportBusy(false),
    });
  }
  function removeContact() {
    if (!contactToDelete) return;
    deleteContact.mutate({ contactId: contactToDelete.id }, {
      onSuccess: () => {
        refreshContacts();
        setSelected((current) => current.filter((id) => id !== contactToDelete.id));
        toast({ title: "تم حذف جهة الاتصال" });
        setContactToDelete(null);
      },
      onError: (error) => toast({ title: "تعذر حذف جهة الاتصال", description: errorText(error), variant: "destructive" }),
    });
  }
  function convertToCustomer(contact: WhatsAppContact) {
    if (!companyId) return;
    setConvertingId(contact.id);
    convertContact.mutate({ contactId: contact.id, data: { companyId } }, {
      onSuccess: (result) => {
        refreshContacts();
        toast({ title: result.created ? "تم تحويل جهة الاتصال إلى عميل" : "جهة الاتصال مرتبطة بعميل بالفعل", description: `رقم العميل ${result.customerId}` });
      },
      onError: (error) => toast({ title: "تعذر التحويل", description: errorText(error), variant: "destructive" }),
      onSettled: () => setConvertingId(null),
    });
  }
  function removeCampaign() {
    if (!campaignToDelete) return;
    deleteCampaign.mutate({ campaignId: campaignToDelete.id }, {
      onSuccess: () => {
        refreshCampaigns();
        if (activeCampaign?.id === campaignToDelete.id) setActiveCampaign(null);
        toast({ title: "تم حذف الحملة" });
        setCampaignToDelete(null);
      },
      onError: (error) => toast({ title: "تعذر حذف الحملة", description: errorText(error), variant: "destructive" }),
    });
  }
  function markRecipient(recipientId: number, status: "sent" | "not_sent") {
    if (!campaignDetail || !companyId) return;
    updateRecipient.mutate({
      campaignId: campaignDetail.id,
      recipientId,
      data: { companyId, status },
    }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetWhatsAppCampaignQueryKey(campaignDetail.id) });
        refreshCampaigns();
      },
      onError: (error) => toast({ title: "تعذر تحديث حالة الإرسال", description: errorText(error), variant: "destructive" }),
    });
  }
  function openWhatsApp(phone: string, message: string) {
    const number = waMeNumber(phone);
    if (number.length < 7 || number.length > 15) {
      toast({ title: "رقم واتساب غير صالح", description: "تحقق من الرقم ومفتاح الدولة.", variant: "destructive" });
      return;
    }
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <main dir="rtl" className="min-h-[100dvh] bg-[#f3f8f5] px-3 py-5 text-[#18382f] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1440px]">
        <header className="mb-6 flex flex-col gap-5 border-b border-[#dce9e3] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.13em] text-[#618075]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#15967d]" />
              CRM <span className="text-[#aac0b6]">/</span> التواصل
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight text-[#173a30] sm:text-[30px]">دفتر واتساب</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-[#6a8179]">جهات اتصال مستقلة، وحملات برسالة واحدة يمكنك الرجوع إليها في أي وقت.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-xl border border-[#dce9e3] bg-white px-3.5 py-2 text-xs text-[#647d73]">
              <span className="font-bold text-[#254b3f]">{contacts.length}</span> جهة اتصال
              <span className="mx-2 text-[#c6d5ce]">|</span>
              <span className="font-bold text-[#254b3f]">{campaigns.length}</span> حملة محفوظة
            </div>
            {tab === "contacts" && <>
              <Button onClick={openImportModal} data-testid="button-import-contacts" variant="outline" className="h-10 rounded-xl border-[#d2e2da] bg-white px-3.5 text-[#315b4d] hover:bg-[#f2f8f5]">
                <Upload className="ml-2 h-4 w-4" /> استيراد
              </Button>
              <Button onClick={openCreateContact} data-testid="button-add-contact" className="h-10 rounded-xl bg-[#137e69] px-4 font-bold text-white shadow-[0_5px_12px_rgba(19,126,105,.15)] hover:bg-[#106e5b]">
                <Plus className="ml-2 h-4 w-4" /> جهة اتصال
              </Button>
            </>}
          </div>
        </header>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex w-full rounded-xl border border-[#dce9e3] bg-[#eaf2ee] p-1 sm:w-auto">
            <button onClick={() => { setTab("contacts"); setSearch(""); }} data-testid="tab-whatsapp-contacts" className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition sm:flex-none ${tab === "contacts" ? "bg-white text-[#1d5545] shadow-sm" : "text-[#738a80] hover:text-[#315d4d]"}`}>
              <ContactRound className="h-4 w-4" /> جهات الاتصال <span className="text-[11px] opacity-65">{contacts.length}</span>
            </button>
            <button onClick={() => { setTab("campaigns"); setSearch(""); }} data-testid="tab-whatsapp-campaigns" className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition sm:flex-none ${tab === "campaigns" ? "bg-white text-[#1d5545] shadow-sm" : "text-[#738a80] hover:text-[#315d4d]"}`}>
              <MessageSquareText className="h-4 w-4" /> الحملات <span className="text-[11px] opacity-65">{campaigns.length}</span>
            </button>
          </div>
          <label className="relative block w-full sm:max-w-[340px]">
            <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8ca49a]" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-whatsapp-search" placeholder={tab === "contacts" ? "ابحث بالاسم أو الرقم" : "ابحث باسم الحملة أو الرسالة"} className={`${inputClass} pr-9`} />
          </label>
        </div>

        {tab === "contacts" ? (
          <section className={panelClass}>
            <div className="flex flex-col gap-3 border-b border-[#e8f0ec] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e7f4ee] text-[#20836d]"><UsersRound className="h-[18px] w-[18px]" /></div>
                <div>
                  <h2 className="text-sm font-extrabold text-[#21473b]">دليل جهات الاتصال</h2>
                  <p className="text-xs text-[#81968c]">أرقام مخصصة للتواصل التسويقي، دون إنشاء سجل عميل تلقائيًا.</p>
                </div>
              </div>
              {selected.length > 0 && <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[#547166]" data-testid="text-selected-contact-count">تم تحديد {selected.length}</span>
                <Button onClick={openCampaignComposer} data-testid="button-create-campaign" className="h-9 rounded-lg bg-[#137e69] px-3 text-xs font-bold text-white hover:bg-[#106e5b]">
                  <MessageCircle className="ml-2 h-4 w-4" /> إنشاء حملة
                </Button>
              </div>}
            </div>
            {contactsQuery.isLoading ? (
              <div className="space-y-3 p-5" data-testid="loading-contacts">{[1, 2, 3, 4].map((item) => <div key={item} className="h-[58px] animate-pulse rounded-xl bg-[#eff5f1]" />)}</div>
            ) : contactsQuery.isError ? (
              <div className="px-5 py-14 text-center" data-testid="error-contacts">
                <p className="mb-3 text-sm font-semibold text-[#8a5348]">تعذر تحميل جهات الاتصال.</p>
                <Button variant="outline" onClick={() => void contactsQuery.refetch()} data-testid="button-retry-contacts" className="rounded-lg">إعادة المحاولة</Button>
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="px-5 py-16 text-center" data-testid="empty-whatsapp-contacts">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#55927e]"><ContactRound className="h-6 w-6" /></div>
                <h3 className="text-base font-bold text-[#2c5145]">{search ? "لا توجد نتائج مطابقة" : "ابدأ بدفتر منفصل لجهات واتساب"}</h3>
                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-[#7a9187]">{search ? "جرّب البحث باسم أو رقم مختلف." : "أضف رقمًا يدويًا أو استورد ملف Excel / CSV. لن يتحول أي شخص إلى عميل إلا بطلب صريح."}</p>
                {!search && <div className="mt-5 flex justify-center gap-2">
                  <Button onClick={openCreateContact} data-testid="button-empty-add-contact" className="rounded-xl bg-[#137e69] text-white hover:bg-[#106e5b]"><Plus className="ml-2 h-4 w-4" /> إضافة جهة</Button>
                   <Button onClick={openImportModal} data-testid="button-empty-import-contact" variant="outline" className="rounded-xl border-[#d2e2da] bg-white"><Upload className="ml-2 h-4 w-4" /> استيراد ملف</Button>
                </div>}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-right">
                  <thead className="bg-[#f7faf8] text-[11px] font-bold text-[#82978e]">
                    <tr>
                      <th className="w-12 px-5 py-3"><input type="checkbox" aria-label="تحديد الكل" checked={allVisibleSelected} onChange={toggleAllVisible} data-testid="checkbox-select-all" className="h-4 w-4 accent-[#14836c]" /></th>
                      <th className="px-3 py-3">جهة الاتصال</th><th className="px-3 py-3">رقم واتساب</th><th className="px-3 py-3">ملاحظات</th><th className="px-3 py-3">ارتباط CRM</th><th className="px-5 py-3 text-left">الإجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#edf2ef]">
                    {filteredContacts.map((contact) => <tr key={contact.id} data-testid={`row-whatsapp-contact-${contact.id}`} className="group transition hover:bg-[#fbfdfc]">
                      <td className="px-5 py-3.5"><input type="checkbox" checked={selected.includes(contact.id)} onChange={() => toggleContact(contact.id)} aria-label={`تحديد ${contact.name}`} data-testid={`checkbox-contact-${contact.id}`} className="h-4 w-4 accent-[#14836c]" /></td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eaf3ee] text-xs font-extrabold text-[#467765]">{contact.name.trim().slice(0, 1)}</div>
                          <div className="min-w-0"><div className="max-w-[190px] truncate text-sm font-bold text-[#2b4d41]" data-testid={`text-contact-name-${contact.id}`}>{contact.name}</div><div className="text-[11px] text-[#98aaa2]">أضيف {dateLabel(contact.createdAt)}</div></div>
                        </div>
                      </td>
                      <td className="px-3 py-3.5"><span dir="ltr" className="font-mono text-[13px] font-medium text-[#49675c]" data-testid={`text-contact-phone-${contact.id}`}>{contact.phone}</span></td>
                      <td className="max-w-[220px] px-3 py-3.5"><span className="block truncate text-xs text-[#83968d]" title={contact.notes ?? ""}>{contact.notes || "—"}</span></td>
                      <td className="px-3 py-3.5">
                        {contact.customerId ? <span className="inline-flex items-center gap-1 rounded-full bg-[#eef5f0] px-2.5 py-1 text-[11px] font-bold text-[#527563]" data-testid={`status-contact-customer-${contact.id}`}><Check className="h-3 w-3" /> عميل #{contact.customerId}</span> :
                          <button disabled={convertingId === contact.id} onClick={() => convertToCustomer(contact)} data-testid={`button-convert-contact-${contact.id}`} className="text-[11px] font-bold text-[#16816b] underline decoration-[#b7d9cc] underline-offset-4 hover:text-[#0c644f] disabled:opacity-50">{convertingId === contact.id ? "جارٍ التحويل..." : "تحويل إلى عميل"}</button>}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-end gap-1 opacity-70 transition group-hover:opacity-100">
                          <button onClick={() => openWhatsApp(contact.phone, "")} data-testid={`button-open-chat-${contact.id}`} title="فتح محادثة واتساب" aria-label={`فتح محادثة واتساب مع ${contact.name}`} className="rounded-lg p-2 text-[#47806d] hover:bg-[#eaf5ef]"><ArrowUpRight className="h-4 w-4" /></button>
                          <button onClick={() => openEditContact(contact)} data-testid={`button-edit-contact-${contact.id}`} title="تعديل" className="rounded-lg p-2 text-[#758d82] hover:bg-[#eff5f1]"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => setContactToDelete(contact)} data-testid={`button-delete-contact-${contact.id}`} title="حذف" className="rounded-lg p-2 text-[#a06b62] hover:bg-[#fcf0ed]"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e8f0ec] px-5 py-3 text-[11px] text-[#8a9c94]">
              <span data-testid="text-contact-list-count">عرض {filteredContacts.length} من {contacts.length} جهة</span>
              <span>لا يتم إرسال الرسائل تلقائيًا من هذا النظام.</span>
            </div>
          </section>
        ) : (
          <section className={panelClass}>
            <div className="flex items-center justify-between border-b border-[#e8f0ec] px-4 py-4 sm:px-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e7f4ee] text-[#20836d]"><MessageSquareText className="h-[18px] w-[18px]" /></div>
                <div><h2 className="text-sm font-extrabold text-[#21473b]">الحملات المحفوظة</h2><p className="text-xs text-[#81968c]">كل حملة تحفظ رسالة واحدة وقائمة المستلمين وحالة كل إرسال.</p></div>
              </div>
            </div>
            {campaignsQuery.isLoading ? <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3" data-testid="loading-campaigns">{[1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl bg-[#eff5f1]" />)}</div> :
              campaignsQuery.isError ? <div className="px-5 py-14 text-center" data-testid="error-campaigns"><p className="mb-3 text-sm font-semibold text-[#8a5348]">تعذر تحميل الحملات.</p><Button variant="outline" onClick={() => void campaignsQuery.refetch()} data-testid="button-retry-campaigns" className="rounded-lg">إعادة المحاولة</Button></div> :
                filteredCampaigns.length === 0 ? <div className="px-5 py-16 text-center" data-testid="empty-whatsapp-campaigns">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#55927e]"><MessageSquareText className="h-6 w-6" /></div>
                  <h3 className="text-base font-bold text-[#2c5145]">{search ? "لا توجد نتائج مطابقة" : "لا توجد حملات محفوظة بعد"}</h3>
                  <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-[#7a9187]">{search ? "جرّب عبارة بحث أخرى." : "حدد جهات اتصال من دفتر واتساب، ثم أنشئ حملة برسالة واحدة قابلة لإعادة الاستخدام."}</p>
                  {!search && <Button onClick={() => setTab("contacts")} data-testid="button-go-to-contacts" variant="outline" className="mt-5 rounded-xl border-[#d2e2da] bg-white"><ContactRound className="ml-2 h-4 w-4" /> اختيار جهات الاتصال</Button>}
                </div> : <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
                  {filteredCampaigns.map((campaign, index) => <article key={campaign.id} data-testid={`card-whatsapp-campaign-${campaign.id}`} className="group relative rounded-xl border border-[#e3ede7] bg-[#fcfdfc] p-4 transition hover:-translate-y-0.5 hover:border-[#c6ded2] hover:shadow-[0_8px_20px_rgba(30,83,63,.06)]">
                    <div className="mb-3 flex items-start justify-between">
                      <div className="flex items-center gap-3"><div className={`flex h-10 w-10 items-center justify-center rounded-xl ${index % 3 === 0 ? "bg-[#e9f3ed] text-[#397c63]" : index % 3 === 1 ? "bg-[#f2f0e8] text-[#887b4d]" : "bg-[#edf1f4] text-[#5a7180]"}`}><MessageCircle className="h-[18px] w-[18px]" /></div><div><h3 className="max-w-[210px] truncate text-sm font-extrabold text-[#2b4d41]" data-testid={`text-campaign-name-${campaign.id}`}>{campaign.name}</h3><p className="mt-0.5 text-[11px] text-[#93a59d]">حُفظت {dateLabel(campaign.createdAt)}</p></div></div>
                      <button onClick={() => setCampaignToDelete(campaign)} data-testid={`button-delete-campaign-${campaign.id}`} aria-label="حذف الحملة" className="rounded-lg p-2 text-[#a06b62] opacity-60 hover:bg-[#fcf0ed] hover:opacity-100"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <p className="mb-4 line-clamp-2 min-h-10 text-xs leading-5 text-[#70867c]" data-testid={`text-campaign-message-${campaign.id}`}>{campaign.message}</p>
                    <div className="flex items-center justify-between border-t border-[#edf2ef] pt-3">
                      <div className="flex gap-3 text-[11px]"><span className="text-[#71867c]"><b className="text-[#345e4d]">{campaign.totalRecipients}</b> مستلم</span><span className="text-[#438069]"><b>{campaign.sentCount}</b> أُرسل</span><span className="text-[#9b8270]"><b>{campaign.notSentCount}</b> لم يُرسل</span></div>
                      <button onClick={() => setActiveCampaign(campaign)} data-testid={`button-view-campaign-${campaign.id}`} className="flex items-center gap-1 text-xs font-bold text-[#16816b] hover:text-[#0e624f]">التفاصيل <ArrowLeft className="h-3.5 w-3.5" /></button>
                    </div>
                  </article>)}
                </div>}
          </section>
        )}

        <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#dce9e3] bg-[#edf5f0] px-4 py-3.5 text-xs leading-5 text-[#648074]">
          <div className="mt-0.5 rounded-md bg-white p-1.5 text-[#328268]"><MessageCircle className="h-4 w-4" /></div>
          <p><strong className="font-bold text-[#35604e]">إرسال يدوي وآمن.</strong> فتح واتساب يجهز محادثة واحدة برسالة الحملة. اضغط «إرسال» داخل واتساب، ثم ارجع وسجّل النتيجة لكل مستلم. فتح المحادثة لا يرسل الرسالة ولا يغيّر الحالة.</p>
        </div>
      </div>

      {contactModal && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#16372e]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title" data-testid="dialog-contact-form">
        <div className="w-full max-w-lg rounded-t-2xl border border-[#dce9e3] bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between"><div><p className="mb-1 text-[11px] font-bold tracking-wide text-[#7b9588]">دفتر واتساب</p><h2 id="contact-dialog-title" className="text-lg font-extrabold text-[#21473b]">{editing ? "تعديل جهة الاتصال" : "إضافة جهة اتصال"}</h2></div><button onClick={() => setContactModal(false)} data-testid="button-close-contact-dialog" className="rounded-lg p-2 text-[#82978e] hover:bg-[#f1f6f3]"><X className="h-4 w-4" /></button></div>
          <div className="space-y-4">
            <label className="block"><span className="mb-1.5 block text-xs font-bold text-[#48685b]">الاسم <i className="text-[#bb6256]">*</i></span><Input autoFocus value={contactForm.name} onChange={(event) => setContactForm({ ...contactForm, name: event.target.value })} data-testid="input-contact-name" placeholder="مثال: سارة العتيبي" className={inputClass} /></label>
            <label className="block"><span className="mb-1.5 block text-xs font-bold text-[#48685b]">رقم الهاتف مع مفتاح الدولة <i className="text-[#bb6256]">*</i></span><Input dir="ltr" value={contactForm.phone} onChange={(event) => setContactForm({ ...contactForm, phone: event.target.value })} data-testid="input-contact-phone" placeholder="+966 5X XXX XXXX" className={`${inputClass} text-left font-mono`} /><span className="mt-1 block text-[10px] text-[#91a49b]">أدخل الرقم بصيغة دولية، مثل ‎+966...</span></label>
            <label className="block"><span className="mb-1.5 block text-xs font-bold text-[#48685b]">ملاحظات <span className="font-normal text-[#97aaa1]">(اختياري)</span></span><Textarea value={contactForm.notes} onChange={(event) => setContactForm({ ...contactForm, notes: event.target.value })} data-testid="input-contact-notes" maxLength={2000} rows={3} placeholder="معلومة داخلية لفريقك..." className="resize-none rounded-xl border-[#dce8e3] bg-[#fbfdfc] text-sm focus-visible:ring-[#15967d]" /></label>
            <p className="rounded-lg bg-[#f1f7f3] px-3 py-2 text-[11px] leading-5 text-[#738a7f]">سيُحفظ الرقم في دفتر واتساب فقط. لن يتم إنشاء عميل في CRM إلا عبر إجراء التحويل الصريح.</p>
          </div>
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setContactModal(false)} data-testid="button-cancel-contact" className="rounded-xl border-[#dce8e3]">إلغاء</Button><Button onClick={saveContact} disabled={pending || !contactForm.name.trim() || !contactForm.phone.trim()} data-testid="button-save-contact" className="rounded-xl bg-[#137e69] px-5 text-white hover:bg-[#106e5b]">{pending ? "جارٍ الحفظ..." : editing ? "حفظ التعديلات" : "إضافة جهة"}</Button></div>
        </div>
      </div>}

      {importModal && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#16372e]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" data-testid="dialog-import-contacts">
        <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-[#dce9e3] bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between"><div><p className="mb-1 text-[11px] font-bold tracking-wide text-[#7b9588]">استيراد جماعي · حتى 1,000 صف</p><h2 id="import-dialog-title" className="text-lg font-extrabold text-[#21473b]">استيراد جهات الاتصال</h2></div><button onClick={() => setImportModal(false)} data-testid="button-close-import-dialog" className="rounded-lg p-2 text-[#82978e] hover:bg-[#f1f6f3]"><X className="h-4 w-4" /></button></div>
           <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" data-testid="input-import-file" onChange={(event) => { void readImportFile(event.target.files?.[0]); event.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} data-testid="button-select-import-file" className="flex w-full flex-col items-center rounded-2xl border border-dashed border-[#b9d4c8] bg-[#f6faf7] px-5 py-8 text-center transition hover:border-[#69a88d] hover:bg-[#f0f8f3]">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-white text-[#398467] shadow-sm"><FileSpreadsheet className="h-5 w-5" /></div>
            <span className="text-sm font-bold text-[#365e4c]">{importFileName || "اختر ملف Excel أو CSV"}</span>
            <span className="mt-1 text-xs text-[#879d92]">.xlsx · .xls · .csv — الأعمدة العربية والإنجليزية مدعومة</span>
          </button>
           <div className="mt-3 rounded-xl bg-[#f7faf8] p-3 text-xs leading-5 text-[#768d82]"><b className="text-[#4a6b5d]">تنسيق الأعمدة:</b> الاسم (Name)، رقم الهاتف (Phone)، وملاحظات (Notes) اختياري. يمكن كذلك استخدام ملف بلا عناوين بالترتيب نفسه. عند تجاوز 1,000 صف، ستُجهّز أول 1,000 فقط.</div>
           <div className="mt-4 rounded-xl border border-[#e4ece7] p-3.5">
             <label className="mb-2 block text-xs font-bold text-[#48685b]" htmlFor="paste-whatsapp-contacts">أو الصق مجموعة أرقام</label>
             <Textarea id="paste-whatsapp-contacts" value={pasteText} onChange={(event) => setPasteText(event.target.value)} data-testid="textarea-paste-contacts" rows={3} placeholder={"رقم واحد في كل سطر\nأو: الاسم، الرقم، الملاحظات"} className="resize-y rounded-lg border-[#dce8e3] bg-[#fbfdfc] text-xs leading-5 focus-visible:ring-[#15967d]" />
             <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
               <span className="text-[10px] text-[#899d93]">الأرقام فقط تُضاف بأسماء مؤقتة مثل «جهة 1».</span>
               <Button onClick={preparePasteImport} disabled={!pasteText.trim()} data-testid="button-prepare-paste-import" size="sm" variant="outline" className="h-8 rounded-lg border-[#d2e2da] text-xs">تجهيز الدفعة</Button>
             </div>
           </div>
          {importRows.length > 0 && <div className="mt-4 overflow-hidden rounded-xl border border-[#e2ece6]">
            <div className="flex items-center justify-between bg-[#f7faf8] px-4 py-3"><div className="text-xs font-bold text-[#49685b]" data-testid="text-import-preview-count">معاينة {importRows.length} صف{importRows.length === 1000 ? " (الحد الأقصى)" : ""}</div><button onClick={() => { setImportRows([]); setImportFileName(""); setImportSummary(null); }} data-testid="button-clear-import-file" className="text-xs font-semibold text-[#8d6c63] hover:underline">إزالة الملف</button></div>
            <div className="max-h-44 overflow-auto">
              <table className="w-full text-right text-xs"><thead className="sticky top-0 bg-white text-[#8a9e94]"><tr><th className="px-4 py-2">الاسم</th><th className="px-4 py-2">رقم الهاتف</th><th className="px-4 py-2">ملاحظات</th></tr></thead><tbody className="divide-y divide-[#eef3f0]">{importRows.slice(0, 6).map((row, index) => <tr key={index} data-testid={`row-import-preview-${index}`}><td className="px-4 py-2 font-semibold text-[#49685b]">{row.name || <span className="text-[#bb6256]">فارغ</span>}</td><td dir="ltr" className="px-4 py-2 text-left font-mono text-[#657f73]">{row.phone || <span className="text-[#bb6256]">فارغ</span>}</td><td className="max-w-[150px] truncate px-4 py-2 text-[#879a91]">{row.notes || "—"}</td></tr>)}</tbody></table>
            </div>
          </div>}
           {importTruncatedRows > 0 && <p className="mt-3 rounded-lg bg-[#fff7e8] px-3 py-2 text-xs text-[#8d744c]" data-testid="notice-import-truncated">تم تجاوز الحد الأقصى؛ سيُستورد أول 1,000 صف فقط، وتم تجاهل {importTruncatedRows} صفًا.</p>}
          {importSummary && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="status-import-summary">
            {[["جديدة", importSummary.created, "text-[#28765b]"], ["مكررة", importSummary.duplicates, "text-[#937d4b]"], ["مستعادة", importSummary.revived, "text-[#4a7184]"], ["غير صالحة", importSummary.invalid, "text-[#a15e53]"]].map(([label, count, color]) => <div key={String(label)} className="rounded-xl bg-[#f4f8f5] p-3 text-center"><div className={`text-xl font-extrabold ${color}`}>{count}</div><div className="mt-1 text-[10px] font-semibold text-[#81968b]">{label}</div></div>)}
          </div>}
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setImportModal(false)} data-testid="button-cancel-import" className="rounded-xl border-[#dce8e3]">إغلاق</Button><Button onClick={runImport} disabled={importBusy || !importRows.length} data-testid="button-confirm-import" className="rounded-xl bg-[#137e69] px-5 text-white hover:bg-[#106e5b]"><Upload className="ml-2 h-4 w-4" />{importBusy ? "جارٍ الاستيراد..." : importSummary ? "إعادة الاستيراد" : `استيراد ${importRows.length || ""}`}</Button></div>
        </div>
      </div>}

      {campaignModal && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#16372e]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="campaign-dialog-title" data-testid="dialog-create-campaign">
        <div className="w-full max-w-xl rounded-t-2xl border border-[#dce9e3] bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between"><div><p className="mb-1 text-[11px] font-bold tracking-wide text-[#7b9588]">رسالة واحدة · قائمة محددة</p><h2 id="campaign-dialog-title" className="text-lg font-extrabold text-[#21473b]">حفظ حملة واتساب</h2></div><button onClick={() => setCampaignModal(false)} data-testid="button-close-campaign-dialog" className="rounded-lg p-2 text-[#82978e] hover:bg-[#f1f6f3]"><X className="h-4 w-4" /></button></div>
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-[#f0f7f3] px-3 py-2.5 text-xs text-[#5c7d6d]"><UsersRound className="h-4 w-4 text-[#3b8b70]" /><b>{selected.length}</b> جهة اتصال ستُضاف إلى قائمة المستلمين.</div>
          <div className="space-y-4">
            <label className="block"><span className="mb-1.5 block text-xs font-bold text-[#48685b]">اسم الحملة <i className="text-[#bb6256]">*</i></span><Input autoFocus value={campaignName} onChange={(event) => setCampaignName(event.target.value)} data-testid="input-campaign-name" maxLength={160} placeholder="مثال: عروض نهاية الشهر" className={inputClass} /></label>
            <label className="block"><div className="mb-1.5 flex items-center justify-between"><span className="text-xs font-bold text-[#48685b]">نص الرسالة <i className="text-[#bb6256]">*</i></span><span className="text-[10px] text-[#92a49b]" data-testid="text-campaign-message-length">{campaignMessage.length} / 4096</span></div><Textarea value={campaignMessage} onChange={(event) => setCampaignMessage(event.target.value)} data-testid="input-campaign-message" maxLength={4096} rows={5} placeholder="اكتب رسالة واحدة لجميع المستلمين..." className="resize-y rounded-xl border-[#dce8e3] bg-[#fbfdfc] text-sm leading-6 focus-visible:ring-[#15967d]" /></label>
          </div>
          <div className="mt-4 rounded-xl border border-[#e5ece8] bg-[#fbfdfc] p-3 text-[11px] leading-5 text-[#71887d]">الحفظ لا يرسل الرسائل. ستفتح محادثة واتساب لمستلم واحد في كل مرة، وتؤكد الإرسال يدويًا داخل واتساب.</div>
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setCampaignModal(false)} data-testid="button-cancel-campaign" className="rounded-xl border-[#dce8e3]">إلغاء</Button><Button onClick={saveCampaign} disabled={createCampaign.isPending || !campaignName.trim() || !campaignMessage.trim()} data-testid="button-save-campaign" className="rounded-xl bg-[#137e69] px-5 text-white hover:bg-[#106e5b]">{createCampaign.isPending ? "جارٍ الحفظ..." : "حفظ الحملة"}</Button></div>
        </div>
      </div>}

      {activeCampaign && <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#16372e]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="campaign-detail-title" data-testid="dialog-campaign-detail">
        <div className="flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[#dce9e3] bg-white shadow-2xl sm:rounded-2xl">
          <div className="flex items-start justify-between border-b border-[#e8f0ec] px-5 py-4 sm:px-6">
            <div className="min-w-0"><div className="mb-1 text-[11px] font-bold tracking-wide text-[#7b9588]">تفاصيل الحملة · {dateLabel(activeCampaign.createdAt)}</div><h2 id="campaign-detail-title" className="truncate text-lg font-extrabold text-[#21473b]" data-testid="text-campaign-detail-name">{activeCampaign.name}</h2></div>
            <button onClick={() => setActiveCampaign(null)} data-testid="button-close-campaign-detail" aria-label="إغلاق التفاصيل" className="rounded-lg p-2 text-[#82978e] hover:bg-[#f1f6f3]"><X className="h-4 w-4" /></button>
          </div>
          <div className="overflow-y-auto px-5 py-4 sm:px-6">
            <div className="rounded-xl border border-[#e1ece5] bg-[#f7faf8] p-4"><div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-[#668175]"><MessageSquareText className="h-4 w-4" /> نص الرسالة المحفوظ</div><p className="whitespace-pre-wrap text-sm leading-6 text-[#385a4b]" data-testid="text-campaign-detail-message">{campaignDetail?.message ?? activeCampaign.message}</p></div>
            <div className="my-4 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-extrabold text-[#294d3f]">قائمة المستلمين</h3><p className="mt-0.5 text-xs text-[#8a9d94]">افتح محادثة واحدة، أرسلها يدويًا، ثم حدّث الحالة.</p></div><div className="flex gap-2 text-[11px]"><span className="rounded-full bg-[#eaf5ee] px-2.5 py-1 font-bold text-[#42785e]">{campaignDetail?.recipients.filter((recipient) => recipient.status === "sent").length ?? activeCampaign.sentCount} أُرسل</span><span className="rounded-full bg-[#f6f2ea] px-2.5 py-1 font-bold text-[#917d55]">{campaignDetail?.recipients.filter((recipient) => recipient.status === "not_sent").length ?? activeCampaign.notSentCount} لم يُرسل</span></div></div>
            {campaignDetailQuery.isLoading ? <div className="space-y-2" data-testid="loading-campaign-detail">{[1, 2, 3].map((item) => <div key={item} className="h-[66px] animate-pulse rounded-xl bg-[#eff5f1]" />)}</div> :
              campaignDetailQuery.isError ? <div className="py-8 text-center" data-testid="error-campaign-detail"><p className="mb-3 text-sm text-[#8a5348]">تعذر تحميل قائمة المستلمين.</p><Button variant="outline" onClick={() => void campaignDetailQuery.refetch()} data-testid="button-retry-campaign-detail" className="rounded-lg">إعادة المحاولة</Button></div> :
              !campaignDetail?.recipients.length ? <div className="rounded-xl bg-[#f7faf8] px-4 py-9 text-center text-sm text-[#82978e]" data-testid="empty-campaign-recipients">لا يوجد مستلمون في هذه الحملة.</div> :
              <div className="space-y-2">{campaignDetail.recipients.map((recipient) => <div key={recipient.id} data-testid={`row-campaign-recipient-${recipient.id}`} className="flex flex-col gap-3 rounded-xl border border-[#e8efeb] bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eef5f0] text-xs font-bold text-[#527866]">{recipient.name.slice(0, 1)}</div><div className="min-w-0"><div className="truncate text-sm font-bold text-[#38594b]">{recipient.name}</div><div dir="ltr" className="text-xs font-mono text-[#82968d]">{recipient.phone}</div></div><span className={`mr-auto flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${recipient.status === "sent" ? "bg-[#eaf5ee] text-[#3e7759]" : "bg-[#f6f2ea] text-[#917d55]"}`} data-testid={`status-recipient-${recipient.id}`}>{recipient.status === "sent" ? <><CheckCheck className="h-3 w-3" /> أُرسل {recipient.sentAt ? dateLabel(recipient.sentAt) : ""}</> : "لم يُرسل"}</span></div>
                <div className="flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
                  <button onClick={() => openWhatsApp(recipient.phone, campaignDetail.message)} data-testid={`button-open-whatsapp-${recipient.id}`} className="flex h-8 items-center gap-1.5 rounded-lg bg-[#e9f4ed] px-2.5 text-[11px] font-bold text-[#3a795e] transition hover:bg-[#dceee2]"><Send className="h-3.5 w-3.5" /> فتح واتساب <ArrowUpRight className="h-3 w-3" /></button>
                  {recipient.status === "not_sent" ? <button disabled={updateRecipient.isPending} onClick={() => markRecipient(recipient.id, "sent")} data-testid={`button-mark-sent-${recipient.id}`} className="h-8 rounded-lg border border-[#d8e8de] px-2.5 text-[11px] font-bold text-[#547866] hover:bg-[#f3f8f4] disabled:opacity-50">تم الإرسال</button> :
                    <button disabled={updateRecipient.isPending} onClick={() => markRecipient(recipient.id, "not_sent")} data-testid={`button-mark-not-sent-${recipient.id}`} className="h-8 rounded-lg border border-[#eadfd7] px-2.5 text-[11px] font-bold text-[#8d6d5f] hover:bg-[#fcf6f2] disabled:opacity-50">تراجع عن الإرسال</button>}
                </div>
              </div>)}</div>
            }
          </div>
          <div className="border-t border-[#e8f0ec] px-5 py-3 text-[11px] leading-5 text-[#81958b] sm:px-6">فتح المحادثة لا يرسل الرسالة ولا يحدّث الحالة. يجب الضغط على إرسال داخل واتساب ثم تسجيل النتيجة هنا.</div>
        </div>
      </div>}

      {(contactToDelete || campaignToDelete) && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#16372e]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="alertdialog" aria-modal="true" data-testid="dialog-confirm-delete">
        <div className="w-full max-w-md rounded-t-2xl border border-[#dce9e3] bg-white p-5 shadow-2xl sm:rounded-2xl">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-[#fbefec] text-[#a26053]"><Trash2 className="h-5 w-5" /></div>
          <h2 className="text-base font-extrabold text-[#294b3e]">تأكيد الحذف</h2>
          <p className="mt-1 text-sm leading-6 text-[#788e84]">{contactToDelete ? `سيتم حذف جهة الاتصال «${contactToDelete.name}» من دفتر واتساب.` : `سيتم حذف الحملة «${campaignToDelete?.name}» وقائمة مستلميها وسجل حالاتها.`}</p>
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => { setContactToDelete(null); setCampaignToDelete(null); }} data-testid="button-cancel-delete" className="rounded-xl border-[#dce8e3]">إلغاء</Button><Button onClick={contactToDelete ? removeContact : removeCampaign} disabled={deleteContact.isPending || deleteCampaign.isPending} data-testid="button-confirm-delete" className="rounded-xl bg-[#a45449] text-white hover:bg-[#8f453c]">حذف</Button></div>
        </div>
      </div>}
    </main>
  );
}
