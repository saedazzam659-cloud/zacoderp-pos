const SEQUENCE_PROTECTION_CODES = new Set([
  "SEQUENCE_PROTECTED_DELETE",
  "SEQUENCE_PROTECTED_NUMBER_CHANGE",
]);

type SequenceProtectionErrorResponse = {
  code: string;
  error: string;
  errorTitle: string;
  errorDescription: string;
};

function findSequenceProtectionCode(error: unknown): string | null {
  const visited = new Set<object>();
  let current: any = error;

  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current !== "object" || visited.has(current)) break;
    visited.add(current);

    const code = String(current.code ?? "");
    const detail = String(current.detail ?? "");
    if (
      SEQUENCE_PROTECTION_CODES.has(detail) &&
      (!code || code === "P0001")
    ) {
      return detail;
    }

    current =
      current.cause ??
      current.originalError ??
      current.original ??
      current.parent;
  }

  return null;
}

export function sequenceProtectionErrorResponse(
  error: unknown,
  requestedLanguage: string | undefined,
): SequenceProtectionErrorResponse | null {
  const code = findSequenceProtectionCode(error);
  if (!code) return null;

  const language = requestedLanguage?.toLowerCase().split(/[-_,]/)[0];
  const isEnglish = language === "en";

  const copy = code === "SEQUENCE_PROTECTED_DELETE"
    ? isEnglish
      ? {
          title: "This document is protected",
          description:
            "It has a protected sequence number and cannot be deleted. To preserve document numbering and the audit trail, use its approved cancellation action instead.",
        }
      : {
          title: "هذا المستند محمي",
          description:
            "يحمل المستند رقمًا تسلسليًا محميًا، لذلك لا يمكن حذفه حفاظًا على تسلسل المستندات وسجل التدقيق. استخدم إجراء الإلغاء المعتمد بدلًا من الحذف.",
        }
    : isEnglish
      ? {
          title: "The document number is protected",
          description:
            "A protected document number cannot be changed after it has been issued.",
        }
      : {
          title: "رقم المستند محمي",
          description: "لا يمكن تغيير رقم مستند محمي بعد إصداره.",
        };

  return {
    code,
    error: `${copy.title}. ${copy.description}`,
    errorTitle: copy.title,
    errorDescription: copy.description,
  };
}