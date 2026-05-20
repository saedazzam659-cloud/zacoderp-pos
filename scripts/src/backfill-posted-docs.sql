-- One-shot backfill: assigns doc_number + creates JE for posted docs missing them.
-- Idempotent: only touches rows where doc_number is NULL/empty OR journal_entry_id is NULL.

BEGIN;

-- Fix missing customer AR accounts (so AR debit lines have a target).
-- AR default = 1210 (id 13 for company 5).
UPDATE customers SET account_id = 13
WHERE company_id = 5 AND account_id IS NULL;

-- Fix missing supplier AP accounts (AP default = 2110, id 14 for company 5).
UPDATE suppliers SET account_id = 14
WHERE company_id = 5 AND account_id IS NULL;

-- ─── SALES INVOICES ────────────────────────────────────────────────────────
DO $$
DECLARE
  inv RECORD;
  je_id INT;
  doc TEXT;
  debit_acc INT;
  debit_desc TEXT;
BEGIN
  FOR inv IN
    SELECT si.*, c.account_id AS cust_acc, cb.account_id AS cash_acc, ba.account_id AS bank_acc
    FROM sales_invoices si
    LEFT JOIN customers c ON c.id = si.customer_id
    LEFT JOIN cash_boxes cb ON cb.id = si.cash_box_id
    LEFT JOIN bank_accounts ba ON ba.id = si.bank_account_id
    WHERE si.company_id = 5 AND si.status = 'posted'
      AND (si.doc_number IS NULL OR si.doc_number = '' OR si.journal_entry_id IS NULL)
    ORDER BY si.id
  LOOP
    doc := COALESCE(NULLIF(inv.doc_number, ''), 'INV-' || LPAD(inv.id::text, 6, '0'));
    IF inv.total_amount = 0 THEN
      UPDATE sales_invoices SET doc_number = doc WHERE id = inv.id;
      CONTINUE;
    END IF;
    IF inv.payment_type = 'cash' THEN
      debit_acc := COALESCE(inv.cash_acc, 24); debit_desc := 'تحصيل نقدي';
    ELSIF inv.payment_type = 'bank' THEN
      debit_acc := COALESCE(inv.bank_acc, 24); debit_desc := 'تحصيل بنكي';
    ELSE
      debit_acc := COALESCE(inv.cust_acc, 13); debit_desc := 'ذمم العميل';
    END IF;

    INSERT INTO journal_entries (company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status)
    VALUES (5, doc, inv.invoice_date, 'SAR', 1, 'قيد فاتورة مبيعات رقم ' || doc, 'sales_invoice', inv.branch_id, 'posted')
    RETURNING id INTO je_id;

    INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order) VALUES
      (je_id, debit_acc, inv.total_amount, 0, debit_desc, 1),
      (je_id, 16, 0, inv.subtotal - inv.discount_amount, 'إيراد المبيعات', 2);
    IF inv.vat_amount > 0 THEN
      INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order)
      VALUES (je_id, 17, 0, inv.vat_amount, 'ضريبة القيمة المضافة (مخرجات)', 3);
    END IF;

    UPDATE sales_invoices SET doc_number = doc, journal_entry_id = je_id WHERE id = inv.id;
  END LOOP;
END $$;

-- ─── SALES RETURNS ────────────────────────────────────────────────────────
DO $$
DECLARE
  ret RECORD;
  je_id INT;
  doc TEXT;
  credit_acc INT;
  credit_desc TEXT;
BEGIN
  FOR ret IN
    SELECT sr.*, c.account_id AS cust_acc, cb.account_id AS cash_acc, ba.account_id AS bank_acc
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id = sr.customer_id
    LEFT JOIN cash_boxes cb ON cb.id = sr.cash_box_id
    LEFT JOIN bank_accounts ba ON ba.id = sr.bank_account_id
    WHERE sr.company_id = 5 AND sr.status = 'posted'
      AND (sr.doc_number IS NULL OR sr.doc_number = '' OR sr.journal_entry_id IS NULL)
    ORDER BY sr.id
  LOOP
    doc := COALESCE(NULLIF(ret.doc_number, ''), 'SR-' || LPAD(ret.id::text, 6, '0'));
    IF ret.total_amount = 0 THEN
      UPDATE sales_returns SET doc_number = doc WHERE id = ret.id;
      CONTINUE;
    END IF;
    IF ret.payment_type = 'cash' THEN
      credit_acc := COALESCE(ret.cash_acc, 24); credit_desc := 'صرف نقدي';
    ELSIF ret.payment_type = 'bank' THEN
      credit_acc := COALESCE(ret.bank_acc, 24); credit_desc := 'صرف بنكي';
    ELSE
      credit_acc := COALESCE(ret.cust_acc, 13); credit_desc := 'تخفيض ذمم العميل';
    END IF;

    INSERT INTO journal_entries (company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status)
    VALUES (5, doc, ret.return_date, 'SAR', 1, 'قيد مرتجع مبيعات رقم ' || doc, 'sales_return', ret.branch_id, 'posted')
    RETURNING id INTO je_id;

    INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order) VALUES
      (je_id, 16, ret.total_amount - ret.vat_amount + ret.discount_amount, 0, 'تخفيض إيراد المبيعات', 1),
      (je_id, credit_acc, 0, ret.total_amount, credit_desc, 3);
    IF ret.vat_amount > 0 THEN
      INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order)
      VALUES (je_id, 17, ret.vat_amount, 0, 'استرداد ضريبة القيمة المضافة', 2);
    END IF;
    IF ret.discount_amount > 0 THEN
      INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order)
      VALUES (je_id, 16, 0, ret.discount_amount, 'استرداد خصم مسموح به', 4);
    END IF;

    UPDATE sales_returns SET doc_number = doc, journal_entry_id = je_id WHERE id = ret.id;
  END LOOP;
END $$;

-- ─── PURCHASE INVOICES ────────────────────────────────────────────────────
DO $$
DECLARE
  pi_row RECORD;
  je_id INT;
  doc TEXT;
  credit_acc INT;
  credit_desc TEXT;
BEGIN
  FOR pi_row IN
    SELECT pi.*, s.account_id AS sup_acc, cb.account_id AS cash_acc, ba.account_id AS bank_acc
    FROM purchase_invoices pi
    LEFT JOIN suppliers s ON s.id = pi.supplier_id
    LEFT JOIN cash_boxes cb ON cb.id = pi.cash_box_id
    LEFT JOIN bank_accounts ba ON ba.id = pi.bank_account_id
    WHERE pi.company_id = 5 AND pi.status = 'posted'
      AND (pi.doc_number IS NULL OR pi.doc_number = '' OR pi.journal_entry_id IS NULL)
    ORDER BY pi.id
  LOOP
    doc := COALESCE(NULLIF(pi_row.doc_number, ''), 'PI-' || LPAD(pi_row.id::text, 6, '0'));
    IF pi_row.total_amount = 0 THEN
      UPDATE purchase_invoices SET doc_number = doc WHERE id = pi_row.id;
      CONTINUE;
    END IF;
    IF pi_row.payment_type = 'cash' THEN
      credit_acc := COALESCE(pi_row.cash_acc, 24); credit_desc := 'سداد نقدي';
    ELSIF pi_row.payment_type = 'bank' THEN
      credit_acc := COALESCE(pi_row.bank_acc, 24); credit_desc := 'سداد بنكي';
    ELSE
      credit_acc := COALESCE(pi_row.sup_acc, 14); credit_desc := 'ذمم المورد';
    END IF;

    INSERT INTO journal_entries (company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status)
    VALUES (5, doc, pi_row.invoice_date, 'SAR', 1, 'قيد فاتورة مشتريات رقم ' || doc, 'purchase_invoice', pi_row.branch_id, 'posted')
    RETURNING id INTO je_id;

    INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order) VALUES
      (je_id, 9, pi_row.subtotal, 0, 'إضافة للمخزون', 1),
      (je_id, credit_acc, 0, pi_row.total_amount, credit_desc, 3);
    IF pi_row.vat_amount > 0 THEN
      INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order)
      VALUES (je_id, 17, pi_row.vat_amount, 0, 'ضريبة القيمة المضافة (مدخلات)', 2);
    END IF;

    UPDATE purchase_invoices SET doc_number = doc, journal_entry_id = je_id WHERE id = pi_row.id;
  END LOOP;
END $$;

-- ─── RECEIPT VOUCHERS ─────────────────────────────────────────────────────
DO $$
DECLARE
  rec RECORD;
  je_id INT;
  debit_acc INT;
  debit_desc TEXT;
BEGIN
  FOR rec IN
    SELECT rv.*, c.account_id AS cust_acc, cb.account_id AS cash_acc, ba.account_id AS bank_acc
    FROM receipt_vouchers rv
    LEFT JOIN customers c ON c.id = rv.entity_id AND rv.entity_type = 'customer'
    LEFT JOIN cash_boxes cb ON cb.id = rv.cash_box_id
    LEFT JOIN bank_accounts ba ON ba.id = rv.bank_account_id
    WHERE rv.company_id = 5 AND rv.status = 'posted' AND rv.journal_entry_id IS NULL
    ORDER BY rv.id
  LOOP
    IF rec.amount = 0 THEN CONTINUE; END IF;
    IF rec.payment_type = 'cash' THEN
      debit_acc := COALESCE(rec.cash_acc, 24); debit_desc := 'تحصيل نقدي';
    ELSE
      debit_acc := COALESCE(rec.bank_acc, 24); debit_desc := 'تحصيل بنكي';
    END IF;

    INSERT INTO journal_entries (company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status)
    VALUES (5, rec.code, rec.date, 'SAR', 1, 'قيد سند قبض رقم ' || rec.code, 'receipt_voucher', rec.branch_id, 'posted')
    RETURNING id INTO je_id;

    INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order) VALUES
      (je_id, debit_acc, rec.amount, 0, debit_desc, 1),
      (je_id, COALESCE(rec.cust_acc, 13), 0, rec.amount, 'تخفيض ذمم العميل', 2);

    UPDATE receipt_vouchers SET journal_entry_id = je_id WHERE id = rec.id;
  END LOOP;
END $$;

-- ─── PAYMENT VOUCHERS ─────────────────────────────────────────────────────
DO $$
DECLARE
  rec RECORD;
  je_id INT;
  credit_acc INT;
  credit_desc TEXT;
BEGIN
  FOR rec IN
    SELECT pv.*, s.account_id AS sup_acc, cb.account_id AS cash_acc, ba.account_id AS bank_acc
    FROM payment_vouchers pv
    LEFT JOIN suppliers s ON s.id = pv.entity_id AND pv.entity_type = 'supplier'
    LEFT JOIN cash_boxes cb ON cb.id = pv.cash_box_id
    LEFT JOIN bank_accounts ba ON ba.id = pv.bank_account_id
    WHERE pv.company_id = 5 AND pv.status = 'posted' AND pv.journal_entry_id IS NULL
    ORDER BY pv.id
  LOOP
    IF rec.amount = 0 THEN CONTINUE; END IF;
    IF rec.payment_type = 'cash' THEN
      credit_acc := COALESCE(rec.cash_acc, 24); credit_desc := 'صرف نقدي';
    ELSE
      credit_acc := COALESCE(rec.bank_acc, 24); credit_desc := 'صرف بنكي';
    END IF;

    INSERT INTO journal_entries (company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status)
    VALUES (5, rec.code, rec.date, 'SAR', 1, 'قيد سند صرف رقم ' || rec.code, 'payment_voucher', rec.branch_id, 'posted')
    RETURNING id INTO je_id;

    INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, description, sort_order) VALUES
      (je_id, COALESCE(rec.sup_acc, 14), rec.amount, 0, 'تخفيض ذمم المورد', 1),
      (je_id, credit_acc, 0, rec.amount, credit_desc, 2);

    UPDATE payment_vouchers SET journal_entry_id = je_id WHERE id = rec.id;
  END LOOP;
END $$;

COMMIT;

-- Verify the result
SELECT 'sales_invoices' AS tbl, COUNT(*) FILTER (WHERE status='posted') AS posted,
       COUNT(*) FILTER (WHERE status='posted' AND doc_number IS NOT NULL AND doc_number<>'') AS with_doc,
       COUNT(*) FILTER (WHERE status='posted' AND journal_entry_id IS NOT NULL) AS with_je
FROM sales_invoices WHERE company_id=5
UNION ALL
SELECT 'sales_returns', COUNT(*) FILTER (WHERE status='posted'),
       COUNT(*) FILTER (WHERE status='posted' AND doc_number IS NOT NULL AND doc_number<>''),
       COUNT(*) FILTER (WHERE status='posted' AND journal_entry_id IS NOT NULL)
FROM sales_returns WHERE company_id=5
UNION ALL
SELECT 'purchase_invoices', COUNT(*) FILTER (WHERE status='posted'),
       COUNT(*) FILTER (WHERE status='posted' AND doc_number IS NOT NULL AND doc_number<>''),
       COUNT(*) FILTER (WHERE status='posted' AND journal_entry_id IS NOT NULL)
FROM purchase_invoices WHERE company_id=5
UNION ALL
SELECT 'receipt_vouchers', COUNT(*) FILTER (WHERE status='posted'),
       COUNT(*) FILTER (WHERE status='posted' AND code IS NOT NULL),
       COUNT(*) FILTER (WHERE status='posted' AND journal_entry_id IS NOT NULL)
FROM receipt_vouchers WHERE company_id=5
UNION ALL
SELECT 'payment_vouchers', COUNT(*) FILTER (WHERE status='posted'),
       COUNT(*) FILTER (WHERE status='posted' AND code IS NOT NULL),
       COUNT(*) FILTER (WHERE status='posted' AND journal_entry_id IS NOT NULL)
FROM payment_vouchers WHERE company_id=5;
