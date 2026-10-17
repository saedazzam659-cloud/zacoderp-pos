type VoiceFillListener = (transcript: string) => boolean;

const listeners = new Set<VoiceFillListener>();

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
