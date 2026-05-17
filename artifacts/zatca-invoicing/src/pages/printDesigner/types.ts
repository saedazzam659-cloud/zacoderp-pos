export type DocumentType =
  | "sales_invoice" | "purchase_invoice" | "sales_return" | "purchase_return"
  | "receipt_voucher" | "payment_voucher" | "bank_receipt" | "treasury_receipt"
  | "account_statement" | "journal_entry";

export type ElementType = "text" | "image" | "rect" | "line" | "table" | "field" | "container";

export interface TableColumn {
  key: string; label: string; width?: number; align?: "start" | "end" | "center";
}

export interface Element {
  id: string;
  type: ElementType;
  x: number; y: number; width: number; height: number;
  rotation?: number;
  zIndex?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  textAlign?: "start" | "end" | "center" | "justify";
  color?: string;
  background?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: string;
  padding?: number;
  opacity?: number;
  text?: string;
  src?: string;
  fieldKey?: string;
  tableSpec?: {
    columns: TableColumn[];
    headerBg?: string;
    headerColor?: string;
    rowBg?: string;
    altRowBg?: string;
    borderColor?: string;
    borderWidth?: number;
  };
}

export interface Layout {
  elements: Element[];
  pageBackground?: string;
  margins?: { top: number; right: number; bottom: number; left: number };
}
