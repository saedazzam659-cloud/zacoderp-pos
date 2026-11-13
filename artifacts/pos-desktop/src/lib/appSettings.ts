// Company profile + number-format settings (دليل الإعدادات).
//
// Mirrors the web app's GeneralSettings: a company logo (base64 data URL),
// company identity (name / VAT / CR) used on the professional journal-entry
// print letterhead, and a per-install decimal-places preference applied to
// every money formatter.
//
// Storage follows the SAME pattern as taxSettings.ts / currency.ts:
// localStorage is the synchronous source of truth for the UI thread; in Tauri
// builds we fire-and-forget mirror each key to SQLite (app_settings) via
// standalone_set_setting so the choice survives a localStorage wipe. Writes
// dispatch a shared event so hooks + the cached decimals refresh in lockstep.

import { useEffect, useState } from "react";
import englishUiTranslations from "../../localization/en-ui.json";

export const APP_SETTINGS_EVENT = "pos-desktop-company-changed";
const EVT = APP_SETTINGS_EVENT;

const LS_LOGO = "pos_desktop_company_logo";   // base64 data URL or https URL
const LS_NAME = "pos_desktop_company_name";
const LS_VAT = "pos_desktop_company_vat";
const LS_CR = "pos_desktop_company_cr";
const LS_PHONE = "pos_desktop_company_phone";
const LS_ADDRESS = "pos_desktop_company_address";
const LS_EMAIL = "pos_desktop_company_email";
const LS_DECIMALS = "pos_desktop_decimal_places";
const LS_HIDE_ZEROS = "pos_desktop_hide_zeros";
const LS_SHOW_FREE_QTY_COLUMN = "pos_desktop_show_free_qty_column";
const LS_NUMBER_SYSTEM = "pos_desktop_number_system";
const LS_UI_LANGUAGE = "pos_desktop_ui_language";
const LS_SALES_INVOICE_LAYOUT = "pos_desktop_sales_invoice_layout";
const LS_DOCUMENT_EDITOR_LAYOUT = "pos_desktop_document_editor_layout";
const LS_JOURNAL_ENTRY_LAYOUT = "pos_desktop_journal_entry_layout";

export type NumberSystem = "arabic" | "latin";
export type UiLanguage = "ar" | "en";
export type DocumentEditorLayout = "classic" | "quick" | "modern" | "erp";
export type SalesInvoiceLayout = DocumentEditorLayout;

const DOCUMENT_EDITOR_LAYOUTS: DocumentEditorLayout[] = ["classic", "quick", "modern", "erp"];

export const DECIMALS_MIN = 0;
export const DECIMALS_MAX = 6;
export const DECIMALS_DEFAULT = 2;

// Soft cap on the stored logo size (~1MB of base64) to avoid bloating
// localStorage / SQLite. Enforced by the upload UI, not here.
export const LOGO_MAX_BASE64_CHARS = 1_400_000;

export type CompanyProfile = {
  logo: string;   // "" when unset
  name: string;
  vat: string;
  cr: string;
  phone: string;
  address: string;
  email: string;
  decimals: number;
};

// ─── Raw readers ─────────────────────────────────────────────────────
function ls(key: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) ?? "";
}

function readDecimals(): number {
  if (typeof window === "undefined") return DECIMALS_DEFAULT;
  const raw = localStorage.getItem(LS_DECIMALS);
  if (raw == null || raw.trim() === "") return DECIMALS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DECIMALS_DEFAULT;
  return Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(n)));
}

// ─── Cached decimals (fast, sync, safe outside React) ────────────────
// fmt() in _adminUi.tsx calls getDecimals() on every format, so we keep a
// module-level cache refreshed on the change event + cross-window storage.
let _decimals = readDecimals();
if (typeof window !== "undefined") {
  const refresh = () => { _decimals = readDecimals(); };
  window.addEventListener(EVT, refresh);
  window.addEventListener("storage", refresh);
}

/** Configured decimal places (0–6, default 2). Synchronous + cached. */
export function getDecimals(): number {
  return _decimals;
}

export function getNumberSystem(): NumberSystem {
  if (typeof window === "undefined") return "arabic";
  return localStorage.getItem(LS_NUMBER_SYSTEM) === "latin" ? "latin" : "arabic";
}

export function setNumberSystem(system: NumberSystem): void {
  writeKey(LS_NUMBER_SYSTEM, system);
  window.dispatchEvent(new Event(EVT));
}

export function useNumberSystem(): NumberSystem {
  const [system, setSystem] = useState<NumberSystem>(() => getNumberSystem());
  useEffect(() => {
    const refresh = () => setSystem(getNumberSystem());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return system;
}

export function getUiLanguage(): UiLanguage {
  if (typeof window === "undefined") return "ar";
  return localStorage.getItem(LS_UI_LANGUAGE) === "en" ? "en" : "ar";
}

export function setUiLanguage(language: UiLanguage): void {
  writeKey(LS_UI_LANGUAGE, language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === "en" ? "ltr" : "rtl";
  window.dispatchEvent(new Event(EVT));
}

export function useUiLanguage(): UiLanguage {
  const [language, setLanguage] = useState<UiLanguage>(() => getUiLanguage());
  useEffect(() => {
    const refresh = () => setLanguage(getUiLanguage());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return language;
}

export function uiText(arabic: string, english: string, language = getUiLanguage()): string {
  return language === "en" ? english : arabic;
}

/** Translate a known static UI enum while leaving unknown/business text untouched. */
export function localizeStaticUiText(value: unknown, language = getUiLanguage()): string {
  if (typeof value !== "string") return "";
  if (language !== "en") return value;
  const key = value.trim().replace(/\s+/g, " ");
  return (englishUiTranslations as Record<string, string>)[key] ?? value;
}

/** Localize a UI template while keeping interpolated values exactly as provided. */
export function uiTemplate(
  arabicParts: string[],
  englishTemplate: string,
  values: unknown[],
  language = getUiLanguage(),
): string {
  const arabicTemplate = arabicParts
    .map((part, index) => part + (index < values.length ? `{{${index}}}` : ""))
    .join("");
  const template = language === "en" ? englishTemplate : arabicTemplate;
  return template.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => String(values[Number(index)]));
}

/** Format stored date values for the active interface language without shifting date-only values across time zones. */
export function formatUiDate(value: string, language = getUiLanguage()): string {
  const input = value.trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00` : input);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString(language === "en" ? "en-GB" : "ar-SA", {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Only allow data:image/* or https:// logo sources (anti-XSS, mirrors web safeLogoSrc). */
export function safeLogoSrc(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.trim();
  if (t.startsWith("data:image/") || t.startsWith("https://")) return t;
  return "";
}

// ─── Profile getters ─────────────────────────────────────────────────
export function getCompanyProfile(): CompanyProfile {
  return {
    logo: safeLogoSrc(ls(LS_LOGO)),
    name: ls(LS_NAME),
    vat: ls(LS_VAT),
    cr: ls(LS_CR),
    phone: ls(LS_PHONE),
    address: ls(LS_ADDRESS),
    email: ls(LS_EMAIL),
    decimals: readDecimals(),
  };
}

// ─── Setters (persist + notify + mirror) ─────────────────────────────
function writeKey(key: string, value: string): void {
  if (typeof window === "undefined") return;
  if (value === "") localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  void mirrorToTauri(key, value);
}

/** Persist the whole profile in one shot, then notify once. */
export function setCompanyProfile(p: CompanyProfile): void {
  if (typeof window === "undefined") return;
  writeKey(LS_LOGO, safeLogoSrc(p.logo));
  writeKey(LS_NAME, (p.name ?? "").trim());
  writeKey(LS_VAT, (p.vat ?? "").trim());
  writeKey(LS_CR, (p.cr ?? "").trim());
  writeKey(LS_PHONE, (p.phone ?? "").trim());
  writeKey(LS_ADDRESS, (p.address ?? "").trim());
  writeKey(LS_EMAIL, (p.email ?? "").trim());
  const dp = Math.min(DECIMALS_MAX, Math.max(DECIMALS_MIN, Math.floor(Number(p.decimals) || 0)));
  writeKey(LS_DECIMALS, String(dp));
  _decimals = dp;
  window.dispatchEvent(new Event(EVT));
}

// ─── React hooks ─────────────────────────────────────────────────────
/** Live company profile — re-renders when any field changes. */
export function useCompanyProfile(): CompanyProfile {
  const [p, setP] = useState<CompanyProfile>(() => getCompanyProfile());
  useEffect(() => {
    const refresh = () => setP(getCompanyProfile());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return p;
}

/** Live decimal places — re-renders when changed. */
export function useDecimals(): number {
  const [dp, setDp] = useState<number>(() => getDecimals());
  useEffect(() => {
    const refresh = () => setDp(getDecimals());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return dp;
}

// ─── Hide-zeros preference ───────────────────────────────────────────
// When ON (the default for fresh installs) numeric input fields render BLANK
// instead of a literal 0, so the user types over an empty box rather than
// fighting a leading zero. Stored "1"/"0"; absent key ⇒ ON.
export function getHideZeros(): boolean {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(LS_HIDE_ZEROS);
  if (raw == null) return true;
  return raw === "1";
}

export function setHideZeros(on: boolean): void {
  writeKey(LS_HIDE_ZEROS, on ? "1" : "0");
  window.dispatchEvent(new Event(EVT));
}

/** Live hide-zeros flag — re-renders when toggled in الإعدادات. */
export function useHideZeros(): boolean {
  const [v, setV] = useState<boolean>(() => getHideZeros());
  useEffect(() => {
    const refresh = () => setV(getHideZeros());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return v;
}

// ─── Free-quantity column visibility ─────────────────────────────────
// Hidden on fresh installs. This affects only the sales-invoice and
// quotation editors; saved quantities and document calculations are unchanged.
export function getShowFreeQuantityColumn(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_SHOW_FREE_QTY_COLUMN) === "1";
}

export function setShowFreeQuantityColumn(show: boolean): void {
  writeKey(LS_SHOW_FREE_QTY_COLUMN, show ? "1" : "0");
  window.dispatchEvent(new Event(EVT));
}

/** Live free-quantity column preference — defaults to hidden on new installs. */
export function useShowFreeQuantityColumn(): boolean {
  const [show, setShow] = useState<boolean>(() => getShowFreeQuantityColumn());
  useEffect(() => {
    const refresh = () => setShow(getShowFreeQuantityColumn());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return show;
}

// ─── Shared document editor layout ────────────────────────────────────
// One app-level choice controls every supported sales and purchasing form.
// Read the old invoice-only key as a migration fallback for existing installs.
export function getDocumentEditorLayout(): DocumentEditorLayout {
  if (typeof window === "undefined") return "classic";
  const value = localStorage.getItem(LS_DOCUMENT_EDITOR_LAYOUT)
    ?? localStorage.getItem(LS_SALES_INVOICE_LAYOUT);
  return DOCUMENT_EDITOR_LAYOUTS.includes(value as DocumentEditorLayout)
    ? value as DocumentEditorLayout
    : "classic";
}

export function setDocumentEditorLayout(layout: DocumentEditorLayout): void {
  if (!DOCUMENT_EDITOR_LAYOUTS.includes(layout)) return;
  writeKey(LS_DOCUMENT_EDITOR_LAYOUT, layout);
  window.dispatchEvent(new Event(EVT));
}

/** Live shared document layout preference, synchronized across app windows and reloads. */
export function useDocumentEditorLayout(): DocumentEditorLayout {
  const [layout, setLayout] = useState<DocumentEditorLayout>(() => getDocumentEditorLayout());
  useEffect(() => {
    const refresh = () => setLayout(getDocumentEditorLayout());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return layout;
}

/** Journal-entry presentation is saved separately from invoice layouts. */
export function getJournalEntryLayout(): DocumentEditorLayout {
  if (typeof window === "undefined") return "modern";
  const value = localStorage.getItem(LS_JOURNAL_ENTRY_LAYOUT);
  return DOCUMENT_EDITOR_LAYOUTS.includes(value as DocumentEditorLayout)
    ? value as DocumentEditorLayout
    : "modern";
}

export function setJournalEntryLayout(layout: DocumentEditorLayout): void {
  if (!DOCUMENT_EDITOR_LAYOUTS.includes(layout)) return;
  writeKey(LS_JOURNAL_ENTRY_LAYOUT, layout);
  window.dispatchEvent(new Event(EVT));
}

export function useJournalEntryLayout(): DocumentEditorLayout {
  const [layout, setLayout] = useState<DocumentEditorLayout>(() => getJournalEntryLayout());
  useEffect(() => {
    const refresh = () => setLayout(getJournalEntryLayout());
    window.addEventListener(EVT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(EVT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return layout;
}

// Backwards-compatible names retained for the existing sales invoice editor.
export const getSalesInvoiceLayout = getDocumentEditorLayout;
export const setSalesInvoiceLayout = setDocumentEditorLayout;
export const useSalesInvoiceLayout = useDocumentEditorLayout;

/** Input-value helper: returns "" for a zero amount when `hide` is on. */
export function blankIfZero(n: number | string | null | undefined, hide: boolean): number | string {
  if (!hide) return n ?? 0;
  return Number(n) === 0 ? "" : (n ?? 0);
}

// ─── Tauri SQLite mirror (fire-and-forget) ───────────────────────────
async function mirrorToTauri(key: string, value: string): Promise<void> {
  if (typeof window === "undefined") return;
  const hasTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!hasTauri) return;
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    await mod.invoke("standalone_set_setting", { key, value });
  } catch {
    // Non-fatal — localStorage remains the source of truth.
  }
}
