/** Exact cent arithmetic for one 386 invoice received in multiple cash events.
 * Allocate from the CUMULATIVE invoice ratio, not each standalone payment:
 * the final receipt absorbs all rounding, so aggregate base + VAT cannot drift. */
export function taxableAdvanceReceiptSlice(input:{
  invoiceBase:bigint; invoiceVat:bigint; previousBase:bigint; previousVat:bigint; gross:bigint;
}):{base:bigint;vat:bigint} {
  const {invoiceBase,invoiceVat,previousBase,previousVat,gross}=input;
  const invoiceGross=invoiceBase+invoiceVat;
  const captured=previousBase+previousVat;
  if (invoiceBase<=0n || invoiceVat<0n || gross<=0n || captured<0n
      || previousBase<0n || previousVat<0n || previousBase>invoiceBase
      || previousVat>invoiceVat || captured+gross>invoiceGross)
    throw new Error("مبلغ قبض السلفة الضريبية يتجاوز رصيد الفاتورة أو المرجع غير متسق");
  const targetBase=captured+gross===invoiceGross
    ? invoiceBase : ((captured+gross)*invoiceBase+invoiceGross/2n)/invoiceGross;
  const base=targetBase-previousBase;
  const vat=gross-base;
  if (base<=0n || vat<0n || base>invoiceBase-previousBase || vat>invoiceVat-previousVat
    || vat!==(base*invoiceVat+invoiceBase/2n)/invoiceBase)
    throw new Error("مبلغ القبض المجزأ لا يتوافق مع تقريب ضريبة الفاتورة الأصلية؛ اختر مبلغاً آخر");
  return {base,vat};
}

/** Proportional recovery of a captured 386 receipt (base-only settlement).
 * The last application absorbs the entire source VAT remainder. */
export function taxableAdvanceRecoverySlice(input:{
  sourceBase:bigint; sourceVat:bigint; previousBase:bigint; previousVat:bigint; base:bigint;
}):bigint {
  const {sourceBase,sourceVat,previousBase,previousVat,base}=input;
  if (sourceBase<=0n || base<=0n || previousBase<0n || previousVat<0n
      || previousBase+base>sourceBase || previousVat>sourceVat)
    throw new Error("استرداد السلفة الضريبية يتجاوز المبلغ المتاح");
  const targetVat=previousBase+base===sourceBase
    ? sourceVat : ((previousBase+base)*sourceVat+sourceBase/2n)/sourceBase;
  const vat=targetVat-previousVat;
  if (vat<0n || vat>sourceVat-previousVat
    || vat!==(base*sourceVat+sourceBase/2n)/sourceBase)
    throw new Error("مبلغ استرداد السلفة المجزأ يتجاوز ضريبة السلفة الأصلية");
  return vat;
}