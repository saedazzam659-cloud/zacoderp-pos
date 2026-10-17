type VoiceFillListener = (transcript: string) => boolean;
type VoiceSaveListener = () => boolean;
type VoiceCommandListener = (transcript: string) => boolean;

const listeners = new Set<VoiceFillListener>();
const saveListeners = new Set<VoiceSaveListener>();
const commandListeners = new Set<VoiceCommandListener>();

export function subscribeVoiceDocumentFill(listener: VoiceFillListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitVoiceDocumentFill(transcript: string): boolean {
  for (const listener of [...listeners]) {
    if (listener(transcript)) return true;
  }
  return false;
}

export function subscribeVoiceDocumentSave(listener: VoiceSaveListener): () => void {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
}

export function emitVoiceDocumentSave(): boolean {
  for (const listener of [...saveListeners]) {
    if (listener()) return true;
  }
  return false;
}

export function subscribeVoiceDocumentCommand(listener: VoiceCommandListener): () => void {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}

export function emitVoiceDocumentCommand(transcript: string): boolean {
  for (const listener of [...commandListeners]) {
    if (listener(transcript)) return true;
  }
  return false;
}

export function normalizeVoiceFillText(value: string): string {
  return value.toLowerCase().normalize('NFKD')
    .replace(/[\u064B-\u0655\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/٫/g, '.')
    .replace(/\s+/g, ' ').trim();
}

export function parseVoiceFillNumbers(text: string): { quantity?: number; unitPrice?: number } {
  const normalized = normalizeVoiceFillText(text);
  const quantityMatch = normalized.match(/(?:كميه|عدد|اضف|اضيف|ضيف|حط|سجل)\s*(\d+)/)
    ?? normalized.match(/(\d+)\s*(?:من|قطعه|قطع|حبه|حبات)/);
  const priceMatch = normalized.match(/(?:بسعر|سعره?|قيمه)\s*(\d+(?:\.\d+)?)/);
  const quantity = quantityMatch ? Number(quantityMatch[1]) : undefined;
  const unitPrice = priceMatch ? Number(priceMatch[1]) : undefined;
  return {
    quantity: quantity && quantity > 0 ? Math.min(quantity, 100000) : undefined,
    unitPrice: Number.isFinite(unitPrice) && unitPrice! >= 0 ? unitPrice : undefined,
  };
}

export function parseVoiceDateValue(value: string): string | undefined {
  const normalized = normalizeVoiceFillText(value);
  const match = normalized.match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/);
  if (!match) return undefined;
  const parts = match[1].split(/[/-]/).map(Number);
  const [year, month, day] = parts[0] > 999 ? parts : [parts[2], parts[1], parts[0]];
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
