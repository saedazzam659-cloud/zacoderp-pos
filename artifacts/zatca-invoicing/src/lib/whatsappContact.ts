export type WhatsAppContact = {
  digits: string;
  international: string;
  display: string;
  waHref: string;
  telHref: string;
  isAgent: boolean;
};

const AGENT_WA_TEXT = encodeURIComponent(
  "السلام عليكم، أرغب في الاستفسار عن خدماتكم.",
);

function toAsciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function displayInternational(digits: string): string {
  if (/^9665\d{8}$/.test(digits)) {
    return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  if (/^201[0125]\d{8}$/.test(digits)) {
    return `+20 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

/**
 * Convert only unambiguous international numbers and common Saudi/Egyptian
 * mobile local forms. Unknown local numbering plans fail closed.
 */
export function normalizeAgentWhatsAppPhone(value: unknown): WhatsAppContact | null {
  if (typeof value !== "string") return null;
  const input = toAsciiDigits(value.trim());
  if (!input || /[^\d+\s().-]/.test(input) || (input.match(/\+/g)?.length ?? 0) > 1) return null;

  const compact = input.replace(/[\s().-]/g, "");
  let digits: string;
  if (/^\+\d+$/.test(compact)) {
    digits = compact.slice(1);
  } else if (/^00\d+$/.test(compact)) {
    digits = compact.slice(2);
  } else if (/^05\d{8}$/.test(compact)) {
    digits = `966${compact.slice(1)}`;
  } else if (/^5\d{8}$/.test(compact)) {
    digits = `966${compact}`;
  } else if (/^01[0125]\d{8}$/.test(compact)) {
    digits = `20${compact.slice(1)}`;
  } else if (/^9665\d{8}$/.test(compact) || /^201[0125]\d{8}$/.test(compact)) {
    digits = compact;
  } else {
    return null;
  }

  // E.164 permits at most 15 digits and cannot start with country code zero.
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  const international = `+${digits}`;
  return {
    digits,
    international,
    display: displayInternational(digits),
    waHref: `https://wa.me/${digits}?text=${AGENT_WA_TEXT}`,
    telHref: `tel:${international}`,
    isAgent: true,
  };
}

export function resolveWhatsAppContact(
  branding: unknown,
  central: WhatsAppContact,
): WhatsAppContact | null {
  if (!branding || typeof branding !== "object") return null;
  const value = branding as { isAgentDomain?: unknown; contactPhone?: unknown };
  if (value.isAgentDomain === false) return central;
  if (value.isAgentDomain === true) return normalizeAgentWhatsAppPhone(value.contactPhone);
  return null;
}