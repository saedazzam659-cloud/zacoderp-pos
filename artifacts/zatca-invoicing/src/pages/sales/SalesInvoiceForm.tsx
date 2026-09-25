import SalesDocumentForm from "./SalesDocumentForm";
import { useLocation } from "wouter";

export default function SalesInvoiceForm() {
  const [path] = useLocation();
  // A new intent needs a fresh form, archive key and idempotency key even
  // when the router keeps the same component instance mounted.
  return <SalesDocumentForm key={path} mode="invoice" />;
}
