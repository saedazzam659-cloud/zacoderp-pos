import type { TFunction } from "i18next";

export type SaveToastFlags = {
  posted?: boolean;
  printed?: boolean;
};

export function getSaveToastTitle(
  t: TFunction,
  { posted = false, printed = false }: SaveToastFlags,
): string {
  if (posted && printed) {
    return t("common.savedToast.savedAndPostedAndPrinted", "تم الحفظ والترحيل والطباعة بنجاح");
  }
  if (posted) {
    return t("common.savedToast.savedAndPosted", "تم الحفظ والترحيل بنجاح");
  }
  if (printed) {
    return t("common.savedToast.savedAndPrinted", "تم الحفظ والطباعة بنجاح");
  }
  return t("common.savedToast.saved", "تم الحفظ بنجاح");
}
