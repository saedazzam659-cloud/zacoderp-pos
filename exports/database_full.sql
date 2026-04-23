--
-- PostgreSQL database dump
--

\restrict 8x0tiDPmUgend7nHhl7R0UKqqcjjguVb3Rhs1vjdebPbAKKVrwmxSYXgWD3mEnI

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public.warehouses DROP CONSTRAINT IF EXISTS warehouses_group_id_warehouse_groups_id_fk;
ALTER TABLE IF EXISTS ONLY public.warehouses DROP CONSTRAINT IF EXISTS warehouses_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.warehouse_groups DROP CONSTRAINT IF EXISTS warehouse_groups_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.user_branches DROP CONSTRAINT IF EXISTS user_branches_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.user_branches DROP CONSTRAINT IF EXISTS user_branches_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.units DROP CONSTRAINT IF EXISTS units_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.support_settings DROP CONSTRAINT IF EXISTS support_settings_updated_by_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.support_messages DROP CONSTRAINT IF EXISTS support_messages_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.support_messages DROP CONSTRAINT IF EXISTS support_messages_resolved_by_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.support_messages DROP CONSTRAINT IF EXISTS support_messages_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.suppliers DROP CONSTRAINT IF EXISTS suppliers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.supplier_settlements DROP CONSTRAINT IF EXISTS supplier_settlements_supplier_id_suppliers_id_fk;
ALTER TABLE IF EXISTS ONLY public.supplier_settlements DROP CONSTRAINT IF EXISTS supplier_settlements_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.supplier_settlements DROP CONSTRAINT IF EXISTS supplier_settlements_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.supplier_groups DROP CONSTRAINT IF EXISTS supplier_groups_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_to_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_to_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_from_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_from_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfer_items DROP CONSTRAINT IF EXISTS stock_transfer_items_unit_id_units_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfer_items DROP CONSTRAINT IF EXISTS stock_transfer_items_transfer_id_stock_transfers_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_transfer_items DROP CONSTRAINT IF EXISTS stock_transfer_items_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_counts DROP CONSTRAINT IF EXISTS stock_counts_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_counts DROP CONSTRAINT IF EXISTS stock_counts_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_count_items DROP CONSTRAINT IF EXISTS stock_count_items_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_count_items DROP CONSTRAINT IF EXISTS stock_count_items_count_id_stock_counts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_warehouse_id_warehouses_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_inventory_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_adjustment_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustment_items DROP CONSTRAINT IF EXISTS stock_adjustment_items_unit_id_units_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustment_items DROP CONSTRAINT IF EXISTS stock_adjustment_items_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.stock_adjustment_items DROP CONSTRAINT IF EXISTS stock_adjustment_items_adjustment_id_stock_adjustments_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_tax_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_sales_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_invoice_id_sales_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_inventory_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_discount_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_customer_id_customers_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_cogs_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_return_lines DROP CONSTRAINT IF EXISTS sales_return_lines_return_id_sales_returns_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_return_lines DROP CONSTRAINT IF EXISTS sales_return_lines_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_quotations DROP CONSTRAINT IF EXISTS sales_quotations_customer_id_customers_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_quotations DROP CONSTRAINT IF EXISTS sales_quotations_converted_invoice_id_sales_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_quotations DROP CONSTRAINT IF EXISTS sales_quotations_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_quotation_lines DROP CONSTRAINT IF EXISTS sales_quotation_lines_quotation_id_sales_quotations_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_quotation_lines DROP CONSTRAINT IF EXISTS sales_quotation_lines_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_tax_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_sales_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_inventory_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_discount_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_customer_id_customers_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_cogs_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoice_lines DROP CONSTRAINT IF EXISTS sales_invoice_lines_invoice_id_sales_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.sales_invoice_lines DROP CONSTRAINT IF EXISTS sales_invoice_lines_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.regions DROP CONSTRAINT IF EXISTS regions_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_cash_box_id_cash_boxes_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_bank_account_id_bank_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_supplier_id_suppliers_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_invoice_id_purchase_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_return_lines DROP CONSTRAINT IF EXISTS purchase_return_lines_return_id_purchase_returns_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_return_lines DROP CONSTRAINT IF EXISTS purchase_return_lines_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_supplier_id_suppliers_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_lc_id_letters_of_credit_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoice_lines DROP CONSTRAINT IF EXISTS purchase_invoice_lines_invoice_id_purchase_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoice_lines DROP CONSTRAINT IF EXISTS purchase_invoice_lines_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.purchase_invoice_lines DROP CONSTRAINT IF EXISTS purchase_invoice_lines_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.pos_terminals DROP CONSTRAINT IF EXISTS pos_terminals_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.pos_terminals DROP CONSTRAINT IF EXISTS pos_terminals_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.pos_sessions DROP CONSTRAINT IF EXISTS pos_sessions_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.pos_sessions DROP CONSTRAINT IF EXISTS pos_sessions_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.payroll_lines DROP CONSTRAINT IF EXISTS payroll_lines_payroll_run_id_payroll_runs_id_fk;
ALTER TABLE IF EXISTS ONLY public.payroll_lines DROP CONSTRAINT IF EXISTS payroll_lines_employee_id_employees_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_cash_box_id_cash_boxes_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_bank_account_id_bank_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_created_by_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.notification_reads DROP CONSTRAINT IF EXISTS notification_reads_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.notification_reads DROP CONSTRAINT IF EXISTS notification_reads_notification_id_notifications_id_fk;
ALTER TABLE IF EXISTS ONLY public.notification_dismissals DROP CONSTRAINT IF EXISTS notification_dismissals_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.notification_dismissals DROP CONSTRAINT IF EXISTS notification_dismissals_notification_id_notifications_id_fk;
ALTER TABLE IF EXISTS ONLY public.letters_of_credit DROP CONSTRAINT IF EXISTS letters_of_credit_supplier_id_suppliers_id_fk;
ALTER TABLE IF EXISTS ONLY public.letters_of_credit DROP CONSTRAINT IF EXISTS letters_of_credit_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.lc_expenses DROP CONSTRAINT IF EXISTS lc_expenses_lc_id_letters_of_credit_id_fk;
ALTER TABLE IF EXISTS ONLY public.lc_expenses DROP CONSTRAINT IF EXISTS lc_expenses_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.lc_expenses DROP CONSTRAINT IF EXISTS lc_expenses_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_entry_id_journal_entries_id_fk;
ALTER TABLE IF EXISTS ONLY public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS items_unit_id_units_id_fk;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS items_group_id_item_groups_id_fk;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS items_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.item_unit_prices DROP CONSTRAINT IF EXISTS item_unit_prices_unit_id_units_id_fk;
ALTER TABLE IF EXISTS ONLY public.item_unit_prices DROP CONSTRAINT IF EXISTS item_unit_prices_item_id_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.item_unit_prices DROP CONSTRAINT IF EXISTS item_unit_prices_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.item_groups DROP CONSTRAINT IF EXISTS item_groups_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.invoices DROP CONSTRAINT IF EXISTS invoices_customer_id_customers_id_fk;
ALTER TABLE IF EXISTS ONLY public.invoices DROP CONSTRAINT IF EXISTS invoices_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_invoice_id_invoices_id_fk;
ALTER TABLE IF EXISTS ONLY public.fiscal_years DROP CONSTRAINT IF EXISTS fiscal_years_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_fiscal_year_id_fiscal_years_id_fk;
ALTER TABLE IF EXISTS ONLY public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_to_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_from_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS employees_payable_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS employees_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS employees_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_loans DROP CONSTRAINT IF EXISTS employee_loans_employee_id_employees_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_loans DROP CONSTRAINT IF EXISTS employee_loans_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_leaves DROP CONSTRAINT IF EXISTS employee_leaves_employee_id_employees_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_leaves DROP CONSTRAINT IF EXISTS employee_leaves_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_contracts DROP CONSTRAINT IF EXISTS employee_contracts_employee_id_employees_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_contracts DROP CONSTRAINT IF EXISTS employee_contracts_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_attendance DROP CONSTRAINT IF EXISTS employee_attendance_employee_id_employees_id_fk;
ALTER TABLE IF EXISTS ONLY public.employee_attendance DROP CONSTRAINT IF EXISTS employee_attendance_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.customers DROP CONSTRAINT IF EXISTS customers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.customer_settlements DROP CONSTRAINT IF EXISTS customer_settlements_customer_id_customers_id_fk;
ALTER TABLE IF EXISTS ONLY public.customer_settlements DROP CONSTRAINT IF EXISTS customer_settlements_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.customer_settlements DROP CONSTRAINT IF EXISTS customer_settlements_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.currencies DROP CONSTRAINT IF EXISTS currencies_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cost_centers DROP CONSTRAINT IF EXISTS cost_centers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_to_cash_box_id_cash_boxes_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_to_bank_id_bank_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_from_cash_box_id_cash_boxes_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_from_bank_id_bank_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_boxes DROP CONSTRAINT IF EXISTS cash_boxes_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_boxes DROP CONSTRAINT IF EXISTS cash_boxes_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_boxes DROP CONSTRAINT IF EXISTS cash_boxes_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.cash_boxes DROP CONSTRAINT IF EXISTS cash_boxes_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.branches DROP CONSTRAINT IF EXISTS branches_region_id_regions_id_fk;
ALTER TABLE IF EXISTS ONLY public.branches DROP CONSTRAINT IF EXISTS branches_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_currency_id_currencies_id_fk;
ALTER TABLE IF EXISTS ONLY public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_branch_id_branches_id_fk;
ALTER TABLE IF EXISTS ONLY public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_id_accounts_id_fk;
ALTER TABLE IF EXISTS ONLY public.auto_backups DROP CONSTRAINT IF EXISTS auto_backups_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.accounts DROP CONSTRAINT IF EXISTS accounts_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.accounting_mappings DROP CONSTRAINT IF EXISTS accounting_mappings_company_id_companies_id_fk;
ALTER TABLE IF EXISTS ONLY public.accounting_mappings DROP CONSTRAINT IF EXISTS accounting_mappings_account_id_accounts_id_fk;
DROP INDEX IF EXISTS public.pos_terminals_company_code_uniq;
DROP INDEX IF EXISTS public.cost_centers_company_code_uq;
DROP INDEX IF EXISTS public.acc_map_company_doc_role_uniq;
ALTER TABLE IF EXISTS ONLY public.warehouses DROP CONSTRAINT IF EXISTS warehouses_pkey;
ALTER TABLE IF EXISTS ONLY public.warehouse_groups DROP CONSTRAINT IF EXISTS warehouse_groups_pkey;
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_username_unique;
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_pkey;
ALTER TABLE IF EXISTS ONLY public.user_branches DROP CONSTRAINT IF EXISTS user_branches_user_id_branch_id_pk;
ALTER TABLE IF EXISTS ONLY public.payroll_runs DROP CONSTRAINT IF EXISTS uq_payroll_company_period;
ALTER TABLE IF EXISTS ONLY public.payroll_runs DROP CONSTRAINT IF EXISTS uq_payroll_company_code;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS uq_employees_company_idnumber;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS uq_employees_company_code;
ALTER TABLE IF EXISTS ONLY public.employee_attendance DROP CONSTRAINT IF EXISTS uq_attendance_emp_date;
ALTER TABLE IF EXISTS ONLY public.units DROP CONSTRAINT IF EXISTS units_pkey;
ALTER TABLE IF EXISTS ONLY public.support_settings DROP CONSTRAINT IF EXISTS support_settings_pkey;
ALTER TABLE IF EXISTS ONLY public.support_messages DROP CONSTRAINT IF EXISTS support_messages_pkey;
ALTER TABLE IF EXISTS ONLY public.suppliers DROP CONSTRAINT IF EXISTS suppliers_pkey;
ALTER TABLE IF EXISTS ONLY public.supplier_settlements DROP CONSTRAINT IF EXISTS supplier_settlements_pkey;
ALTER TABLE IF EXISTS ONLY public.supplier_groups DROP CONSTRAINT IF EXISTS supplier_groups_pkey;
ALTER TABLE IF EXISTS ONLY public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_transfer_items DROP CONSTRAINT IF EXISTS stock_transfer_items_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_counts DROP CONSTRAINT IF EXISTS stock_counts_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_count_items DROP CONSTRAINT IF EXISTS stock_count_items_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_pkey;
ALTER TABLE IF EXISTS ONLY public.stock_adjustment_items DROP CONSTRAINT IF EXISTS stock_adjustment_items_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_returns DROP CONSTRAINT IF EXISTS sales_returns_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_return_lines DROP CONSTRAINT IF EXISTS sales_return_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_quotations DROP CONSTRAINT IF EXISTS sales_quotations_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_quotation_lines DROP CONSTRAINT IF EXISTS sales_quotation_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_pkey;
ALTER TABLE IF EXISTS ONLY public.sales_invoice_lines DROP CONSTRAINT IF EXISTS sales_invoice_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.regions DROP CONSTRAINT IF EXISTS regions_pkey;
ALTER TABLE IF EXISTS ONLY public.receipt_vouchers DROP CONSTRAINT IF EXISTS receipt_vouchers_pkey;
ALTER TABLE IF EXISTS ONLY public.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_pkey;
ALTER TABLE IF EXISTS ONLY public.purchase_return_lines DROP CONSTRAINT IF EXISTS purchase_return_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_pkey;
ALTER TABLE IF EXISTS ONLY public.purchase_invoice_lines DROP CONSTRAINT IF EXISTS purchase_invoice_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.pos_terminals DROP CONSTRAINT IF EXISTS pos_terminals_pkey;
ALTER TABLE IF EXISTS ONLY public.pos_sessions DROP CONSTRAINT IF EXISTS pos_sessions_pkey;
ALTER TABLE IF EXISTS ONLY public.plan_configs DROP CONSTRAINT IF EXISTS plan_configs_pkey;
ALTER TABLE IF EXISTS ONLY public.plan_configs DROP CONSTRAINT IF EXISTS plan_configs_key_unique;
ALTER TABLE IF EXISTS ONLY public.payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_pkey;
ALTER TABLE IF EXISTS ONLY public.payroll_lines DROP CONSTRAINT IF EXISTS payroll_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_pkey;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_pkey;
ALTER TABLE IF EXISTS ONLY public.notification_reads DROP CONSTRAINT IF EXISTS notification_reads_notification_id_user_id_pk;
ALTER TABLE IF EXISTS ONLY public.notification_dismissals DROP CONSTRAINT IF EXISTS notification_dismissals_notification_id_user_id_pk;
ALTER TABLE IF EXISTS ONLY public.letters_of_credit DROP CONSTRAINT IF EXISTS letters_of_credit_pkey;
ALTER TABLE IF EXISTS ONLY public.lc_expenses DROP CONSTRAINT IF EXISTS lc_expenses_pkey;
ALTER TABLE IF EXISTS ONLY public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_pkey;
ALTER TABLE IF EXISTS ONLY public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_pkey;
ALTER TABLE IF EXISTS ONLY public.items DROP CONSTRAINT IF EXISTS items_pkey;
ALTER TABLE IF EXISTS ONLY public.item_unit_prices DROP CONSTRAINT IF EXISTS item_unit_prices_pkey;
ALTER TABLE IF EXISTS ONLY public.item_groups DROP CONSTRAINT IF EXISTS item_groups_pkey;
ALTER TABLE IF EXISTS ONLY public.invoices DROP CONSTRAINT IF EXISTS invoices_pkey;
ALTER TABLE IF EXISTS ONLY public.invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_unique;
ALTER TABLE IF EXISTS ONLY public.invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_pkey;
ALTER TABLE IF EXISTS ONLY public.fiscal_years DROP CONSTRAINT IF EXISTS fiscal_years_pkey;
ALTER TABLE IF EXISTS ONLY public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_pkey;
ALTER TABLE IF EXISTS ONLY public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_pkey;
ALTER TABLE IF EXISTS ONLY public.employees DROP CONSTRAINT IF EXISTS employees_pkey;
ALTER TABLE IF EXISTS ONLY public.employee_loans DROP CONSTRAINT IF EXISTS employee_loans_pkey;
ALTER TABLE IF EXISTS ONLY public.employee_leaves DROP CONSTRAINT IF EXISTS employee_leaves_pkey;
ALTER TABLE IF EXISTS ONLY public.employee_contracts DROP CONSTRAINT IF EXISTS employee_contracts_pkey;
ALTER TABLE IF EXISTS ONLY public.employee_attendance DROP CONSTRAINT IF EXISTS employee_attendance_pkey;
ALTER TABLE IF EXISTS ONLY public.customers DROP CONSTRAINT IF EXISTS customers_pkey;
ALTER TABLE IF EXISTS ONLY public.customer_settlements DROP CONSTRAINT IF EXISTS customer_settlements_pkey;
ALTER TABLE IF EXISTS ONLY public.currencies DROP CONSTRAINT IF EXISTS currencies_pkey;
ALTER TABLE IF EXISTS ONLY public.cost_centers DROP CONSTRAINT IF EXISTS cost_centers_pkey;
ALTER TABLE IF EXISTS ONLY public.companies DROP CONSTRAINT IF EXISTS companies_pkey;
ALTER TABLE IF EXISTS ONLY public.cash_transfers DROP CONSTRAINT IF EXISTS cash_transfers_pkey;
ALTER TABLE IF EXISTS ONLY public.cash_boxes DROP CONSTRAINT IF EXISTS cash_boxes_pkey;
ALTER TABLE IF EXISTS ONLY public.branches DROP CONSTRAINT IF EXISTS branches_pkey;
ALTER TABLE IF EXISTS ONLY public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_pkey;
ALTER TABLE IF EXISTS ONLY public.auto_backups DROP CONSTRAINT IF EXISTS auto_backups_pkey;
ALTER TABLE IF EXISTS ONLY public.accounts DROP CONSTRAINT IF EXISTS accounts_pkey;
ALTER TABLE IF EXISTS ONLY public.accounting_mappings DROP CONSTRAINT IF EXISTS accounting_mappings_pkey;
ALTER TABLE IF EXISTS public.warehouses ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.warehouse_groups ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.users ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.units ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.support_settings ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.support_messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.suppliers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.supplier_settlements ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.supplier_groups ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.subscriptions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_transfers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_transfer_items ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_ledger ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_counts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_count_items ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_balance ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_adjustments ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.stock_adjustment_items ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_returns ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_return_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_quotations ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_quotation_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_invoices ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.sales_invoice_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.regions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.receipt_vouchers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.purchase_returns ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.purchase_return_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.purchase_invoices ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.purchase_invoice_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.pos_terminals ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.pos_sessions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.plan_configs ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.payroll_runs ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.payroll_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.payment_vouchers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.notifications ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.letters_of_credit ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.lc_expenses ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.journal_entry_lines ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.journal_entries ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.items ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.item_unit_prices ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.item_groups ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.invoices ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.invoice_line_items ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.fiscal_years ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.fiscal_periods ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.exchange_rates ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.employees ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.employee_loans ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.employee_leaves ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.employee_contracts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.employee_attendance ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.customers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.customer_settlements ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.currencies ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.cost_centers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.companies ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.cash_transfers ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.cash_boxes ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.branches ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.bank_accounts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.auto_backups ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.accounts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.accounting_mappings ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS public.warehouses_id_seq;
DROP TABLE IF EXISTS public.warehouses;
DROP SEQUENCE IF EXISTS public.warehouse_groups_id_seq;
DROP TABLE IF EXISTS public.warehouse_groups;
DROP SEQUENCE IF EXISTS public.users_id_seq;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.user_branches;
DROP SEQUENCE IF EXISTS public.units_id_seq;
DROP TABLE IF EXISTS public.units;
DROP SEQUENCE IF EXISTS public.support_settings_id_seq;
DROP TABLE IF EXISTS public.support_settings;
DROP SEQUENCE IF EXISTS public.support_messages_id_seq;
DROP TABLE IF EXISTS public.support_messages;
DROP SEQUENCE IF EXISTS public.suppliers_id_seq;
DROP TABLE IF EXISTS public.suppliers;
DROP SEQUENCE IF EXISTS public.supplier_settlements_id_seq;
DROP TABLE IF EXISTS public.supplier_settlements;
DROP SEQUENCE IF EXISTS public.supplier_groups_id_seq;
DROP TABLE IF EXISTS public.supplier_groups;
DROP SEQUENCE IF EXISTS public.subscriptions_id_seq;
DROP TABLE IF EXISTS public.subscriptions;
DROP SEQUENCE IF EXISTS public.stock_transfers_id_seq;
DROP TABLE IF EXISTS public.stock_transfers;
DROP SEQUENCE IF EXISTS public.stock_transfer_items_id_seq;
DROP TABLE IF EXISTS public.stock_transfer_items;
DROP SEQUENCE IF EXISTS public.stock_ledger_id_seq;
DROP TABLE IF EXISTS public.stock_ledger;
DROP SEQUENCE IF EXISTS public.stock_counts_id_seq;
DROP TABLE IF EXISTS public.stock_counts;
DROP SEQUENCE IF EXISTS public.stock_count_items_id_seq;
DROP TABLE IF EXISTS public.stock_count_items;
DROP SEQUENCE IF EXISTS public.stock_balance_id_seq;
DROP TABLE IF EXISTS public.stock_balance;
DROP SEQUENCE IF EXISTS public.stock_adjustments_id_seq;
DROP TABLE IF EXISTS public.stock_adjustments;
DROP SEQUENCE IF EXISTS public.stock_adjustment_items_id_seq;
DROP TABLE IF EXISTS public.stock_adjustment_items;
DROP SEQUENCE IF EXISTS public.sales_returns_id_seq;
DROP TABLE IF EXISTS public.sales_returns;
DROP SEQUENCE IF EXISTS public.sales_return_lines_id_seq;
DROP TABLE IF EXISTS public.sales_return_lines;
DROP SEQUENCE IF EXISTS public.sales_quotations_id_seq;
DROP TABLE IF EXISTS public.sales_quotations;
DROP SEQUENCE IF EXISTS public.sales_quotation_lines_id_seq;
DROP TABLE IF EXISTS public.sales_quotation_lines;
DROP SEQUENCE IF EXISTS public.sales_invoices_id_seq;
DROP TABLE IF EXISTS public.sales_invoices;
DROP SEQUENCE IF EXISTS public.sales_invoice_lines_id_seq;
DROP TABLE IF EXISTS public.sales_invoice_lines;
DROP SEQUENCE IF EXISTS public.regions_id_seq;
DROP TABLE IF EXISTS public.regions;
DROP SEQUENCE IF EXISTS public.receipt_vouchers_id_seq;
DROP TABLE IF EXISTS public.receipt_vouchers;
DROP SEQUENCE IF EXISTS public.purchase_returns_id_seq;
DROP TABLE IF EXISTS public.purchase_returns;
DROP SEQUENCE IF EXISTS public.purchase_return_lines_id_seq;
DROP TABLE IF EXISTS public.purchase_return_lines;
DROP SEQUENCE IF EXISTS public.purchase_invoices_id_seq;
DROP TABLE IF EXISTS public.purchase_invoices;
DROP SEQUENCE IF EXISTS public.purchase_invoice_lines_id_seq;
DROP TABLE IF EXISTS public.purchase_invoice_lines;
DROP SEQUENCE IF EXISTS public.pos_terminals_id_seq;
DROP TABLE IF EXISTS public.pos_terminals;
DROP SEQUENCE IF EXISTS public.pos_sessions_id_seq;
DROP TABLE IF EXISTS public.pos_sessions;
DROP SEQUENCE IF EXISTS public.plan_configs_id_seq;
DROP TABLE IF EXISTS public.plan_configs;
DROP SEQUENCE IF EXISTS public.payroll_runs_id_seq;
DROP TABLE IF EXISTS public.payroll_runs;
DROP SEQUENCE IF EXISTS public.payroll_lines_id_seq;
DROP TABLE IF EXISTS public.payroll_lines;
DROP SEQUENCE IF EXISTS public.payment_vouchers_id_seq;
DROP TABLE IF EXISTS public.payment_vouchers;
DROP SEQUENCE IF EXISTS public.notifications_id_seq;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.notification_reads;
DROP TABLE IF EXISTS public.notification_dismissals;
DROP SEQUENCE IF EXISTS public.letters_of_credit_id_seq;
DROP TABLE IF EXISTS public.letters_of_credit;
DROP SEQUENCE IF EXISTS public.lc_expenses_id_seq;
DROP TABLE IF EXISTS public.lc_expenses;
DROP SEQUENCE IF EXISTS public.journal_entry_lines_id_seq;
DROP TABLE IF EXISTS public.journal_entry_lines;
DROP SEQUENCE IF EXISTS public.journal_entries_id_seq;
DROP TABLE IF EXISTS public.journal_entries;
DROP SEQUENCE IF EXISTS public.items_id_seq;
DROP TABLE IF EXISTS public.items;
DROP SEQUENCE IF EXISTS public.item_unit_prices_id_seq;
DROP TABLE IF EXISTS public.item_unit_prices;
DROP SEQUENCE IF EXISTS public.item_groups_id_seq;
DROP TABLE IF EXISTS public.item_groups;
DROP SEQUENCE IF EXISTS public.invoices_id_seq;
DROP TABLE IF EXISTS public.invoices;
DROP SEQUENCE IF EXISTS public.invoice_line_items_id_seq;
DROP TABLE IF EXISTS public.invoice_line_items;
DROP SEQUENCE IF EXISTS public.fiscal_years_id_seq;
DROP TABLE IF EXISTS public.fiscal_years;
DROP SEQUENCE IF EXISTS public.fiscal_periods_id_seq;
DROP TABLE IF EXISTS public.fiscal_periods;
DROP SEQUENCE IF EXISTS public.exchange_rates_id_seq;
DROP TABLE IF EXISTS public.exchange_rates;
DROP SEQUENCE IF EXISTS public.employees_id_seq;
DROP TABLE IF EXISTS public.employees;
DROP SEQUENCE IF EXISTS public.employee_loans_id_seq;
DROP TABLE IF EXISTS public.employee_loans;
DROP SEQUENCE IF EXISTS public.employee_leaves_id_seq;
DROP TABLE IF EXISTS public.employee_leaves;
DROP SEQUENCE IF EXISTS public.employee_contracts_id_seq;
DROP TABLE IF EXISTS public.employee_contracts;
DROP SEQUENCE IF EXISTS public.employee_attendance_id_seq;
DROP TABLE IF EXISTS public.employee_attendance;
DROP SEQUENCE IF EXISTS public.customers_id_seq;
DROP TABLE IF EXISTS public.customers;
DROP SEQUENCE IF EXISTS public.customer_settlements_id_seq;
DROP TABLE IF EXISTS public.customer_settlements;
DROP SEQUENCE IF EXISTS public.currencies_id_seq;
DROP TABLE IF EXISTS public.currencies;
DROP SEQUENCE IF EXISTS public.cost_centers_id_seq;
DROP TABLE IF EXISTS public.cost_centers;
DROP SEQUENCE IF EXISTS public.companies_id_seq;
DROP TABLE IF EXISTS public.companies;
DROP SEQUENCE IF EXISTS public.cash_transfers_id_seq;
DROP TABLE IF EXISTS public.cash_transfers;
DROP SEQUENCE IF EXISTS public.cash_boxes_id_seq;
DROP TABLE IF EXISTS public.cash_boxes;
DROP SEQUENCE IF EXISTS public.branches_id_seq;
DROP TABLE IF EXISTS public.branches;
DROP SEQUENCE IF EXISTS public.bank_accounts_id_seq;
DROP TABLE IF EXISTS public.bank_accounts;
DROP SEQUENCE IF EXISTS public.auto_backups_id_seq;
DROP TABLE IF EXISTS public.auto_backups;
DROP SEQUENCE IF EXISTS public.accounts_id_seq;
DROP TABLE IF EXISTS public.accounts;
DROP SEQUENCE IF EXISTS public.accounting_mappings_id_seq;
DROP TABLE IF EXISTS public.accounting_mappings;
DROP TYPE IF EXISTS public.sales_quotation_status;
DROP TYPE IF EXISTS public.sales_invoice_status;
DROP TYPE IF EXISTS public.purchase_invoice_status;
DROP TYPE IF EXISTS public.pos_session_status;
DROP TYPE IF EXISTS public.lc_status;
DROP TYPE IF EXISTS public.item_type;
DROP TYPE IF EXISTS public.item_status;
DROP TYPE IF EXISTS public.inv_tx_type;
DROP TYPE IF EXISTS public.inv_doc_status;
DROP TYPE IF EXISTS public.fiscal_period_status;
DROP TYPE IF EXISTS public.distribution_method;
DROP TYPE IF EXISTS public.cost_method;
DROP TYPE IF EXISTS public.cash_voucher_status;
DROP TYPE IF EXISTS public.cash_transfer_type;
DROP TYPE IF EXISTS public.cash_payment_type;
DROP TYPE IF EXISTS public.cash_entity_type;
DROP TYPE IF EXISTS public.account_type;
DROP EXTENSION IF EXISTS pgcrypto;
--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: account_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_type AS ENUM (
    'asset',
    'liability',
    'equity',
    'revenue',
    'expense'
);


--
-- Name: cash_entity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cash_entity_type AS ENUM (
    'customer',
    'supplier',
    'other'
);


--
-- Name: cash_payment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cash_payment_type AS ENUM (
    'cash',
    'bank'
);


--
-- Name: cash_transfer_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cash_transfer_type AS ENUM (
    'cash_to_cash',
    'cash_to_bank',
    'bank_to_cash',
    'bank_to_bank'
);


--
-- Name: cash_voucher_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cash_voucher_status AS ENUM (
    'draft',
    'posted'
);


--
-- Name: cost_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cost_method AS ENUM (
    'weighted_avg',
    'last_cost'
);


--
-- Name: distribution_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.distribution_method AS ENUM (
    'qty',
    'value',
    'weight',
    'manual'
);


--
-- Name: fiscal_period_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fiscal_period_status AS ENUM (
    'open',
    'closed',
    'permanently_closed'
);


--
-- Name: inv_doc_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.inv_doc_status AS ENUM (
    'draft',
    'posted',
    'cancelled'
);


--
-- Name: inv_tx_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.inv_tx_type AS ENUM (
    'transfer_out',
    'transfer_in',
    'adjustment',
    'count_adj',
    'sale',
    'sales_return',
    'purchase',
    'purchase_return',
    'opening'
);


--
-- Name: item_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.item_status AS ENUM (
    'active',
    'inactive'
);


--
-- Name: item_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.item_type AS ENUM (
    'stock',
    'service'
);


--
-- Name: lc_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.lc_status AS ENUM (
    'open',
    'partial',
    'closed'
);


--
-- Name: pos_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pos_session_status AS ENUM (
    'open',
    'closed',
    'force_closed'
);


--
-- Name: purchase_invoice_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.purchase_invoice_status AS ENUM (
    'draft',
    'posted',
    'cancelled'
);


--
-- Name: sales_invoice_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sales_invoice_status AS ENUM (
    'draft',
    'posted',
    'cancelled'
);


--
-- Name: sales_quotation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sales_quotation_status AS ENUM (
    'draft',
    'sent',
    'accepted',
    'rejected',
    'converted'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounting_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounting_mappings (
    id integer NOT NULL,
    company_id integer NOT NULL,
    document_type text NOT NULL,
    role_key text NOT NULL,
    account_id integer,
    is_locked boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: accounting_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounting_mappings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounting_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounting_mappings_id_seq OWNED BY public.accounting_mappings.id;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    company_id integer NOT NULL,
    parent_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    account_type public.account_type NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    is_posting boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    report_direction text
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: auto_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_backups (
    id integer NOT NULL,
    company_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    reason text DEFAULT 'scheduled'::text NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    counts jsonb NOT NULL,
    data jsonb NOT NULL
);


--
-- Name: auto_backups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_backups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_backups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_backups_id_seq OWNED BY public.auto_backups.id;


--
-- Name: bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_accounts (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    bank_name text,
    bank_name_en text,
    account_number text,
    iban text,
    swift_code text,
    currency_id integer,
    account_id integer,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: bank_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bank_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bank_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bank_accounts_id_seq OWNED BY public.bank_accounts.id;


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    region_id integer,
    company_id integer,
    city text,
    address text,
    phone text,
    email text,
    is_main boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: branches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.branches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: branches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.branches_id_seq OWNED BY public.branches.id;


--
-- Name: cash_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_boxes (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    currency_id integer,
    account_id integer,
    min_balance numeric(15,2) DEFAULT '0'::numeric,
    max_balance numeric(15,2),
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cash_boxes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_boxes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_boxes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_boxes_id_seq OWNED BY public.cash_boxes.id;


--
-- Name: cash_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_transfers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    date text NOT NULL,
    transfer_type public.cash_transfer_type DEFAULT 'cash_to_bank'::public.cash_transfer_type NOT NULL,
    from_cash_box_id integer,
    from_bank_id integer,
    to_cash_box_id integer,
    to_bank_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_id integer,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric,
    description text,
    notes text,
    status public.cash_voucher_status DEFAULT 'draft'::public.cash_voucher_status NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cash_transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_transfers_id_seq OWNED BY public.cash_transfers.id;


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id integer NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    vat_number text NOT NULL,
    cr_number text NOT NULL,
    city text NOT NULL,
    district text,
    street text NOT NULL,
    building_number text NOT NULL,
    postal_code text NOT NULL,
    additional_number text,
    country text DEFAULT 'SA'::text NOT NULL,
    industry_name text,
    invoice_type text DEFAULT 'both'::text NOT NULL,
    is_sandbox boolean DEFAULT false NOT NULL,
    serial_number text,
    device_serial1 text,
    device_serial2 text,
    device_serial3 text,
    zatca_csid text,
    zatca_pcsid text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    zatca_private_key text,
    zatca_csr text,
    zatca_csid_token text,
    zatca_csid_secret text,
    zatca_pcsid_token text,
    zatca_pcsid_secret text,
    invoice_counter integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    rejection_reason text,
    registration_ip text,
    menu_permissions text DEFAULT '{"invoices":true,"customers":true,"suppliers":true,"zatca":true}'::text,
    logo text,
    decimal_places integer DEFAULT 2 NOT NULL,
    hr_salaries_expense_account_id integer,
    hr_allowances_expense_account_id integer,
    hr_gosi_expense_account_id integer,
    hr_eos_expense_account_id integer,
    hr_salaries_payable_account_id integer,
    hr_gosi_payable_account_id integer,
    hr_other_deductions_account_id integer,
    hr_employee_loans_account_id integer,
    hr_eos_provision_account_id integer,
    hr_default_pay_cashbox_id integer,
    hr_default_pay_bank_account_id integer,
    pos_cash_cashbox_id integer,
    pos_card_bank_account_id integer,
    pos_apple_bank_account_id integer,
    pos_wallet_bank_account_id integer,
    auto_posting_enabled boolean DEFAULT true NOT NULL,
    auto_backup_enabled boolean DEFAULT true NOT NULL,
    auto_backup_frequency_hours integer DEFAULT 24 NOT NULL,
    auto_backup_retention integer DEFAULT 7 NOT NULL,
    last_auto_backup_at timestamp without time zone
);


--
-- Name: companies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: companies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.companies_id_seq OWNED BY public.companies.id;


--
-- Name: cost_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_centers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    parent_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    level integer DEFAULT 1 NOT NULL,
    is_posting boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cost_centers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cost_centers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cost_centers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cost_centers_id_seq OWNED BY public.cost_centers.id;


--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currencies (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    symbol text,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: currencies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.currencies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: currencies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.currencies_id_seq OWNED BY public.currencies.id;


--
-- Name: customer_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_settlements (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    settlement_date text NOT NULL,
    customer_id integer,
    payment_method text DEFAULT 'bank'::text NOT NULL,
    account_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_settlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_settlements_id_seq OWNED BY public.customer_settlements.id;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    vat_number text,
    cr_number text,
    email text,
    phone text,
    city text,
    district text,
    street text,
    building_number text,
    postal_code text,
    country text DEFAULT 'SA'::text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    account_id integer
);


--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;


--
-- Name: employee_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_attendance (
    id integer NOT NULL,
    company_id integer NOT NULL,
    employee_id integer NOT NULL,
    date date NOT NULL,
    check_in text,
    check_out text,
    worked_hours numeric(6,2) DEFAULT '0'::numeric,
    overtime_hours numeric(6,2) DEFAULT '0'::numeric,
    late_minutes integer DEFAULT 0,
    status text DEFAULT 'present'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: employee_attendance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_attendance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employee_attendance_id_seq OWNED BY public.employee_attendance.id;


--
-- Name: employee_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_contracts (
    id integer NOT NULL,
    company_id integer NOT NULL,
    employee_id integer NOT NULL,
    contract_number text NOT NULL,
    contract_type text DEFAULT 'fixed'::text NOT NULL,
    start_date date NOT NULL,
    end_date date,
    basic_salary numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    housing_allow numeric(12,2) DEFAULT '0'::numeric,
    transport_allow numeric(12,2) DEFAULT '0'::numeric,
    other_allow numeric(12,2) DEFAULT '0'::numeric,
    working_hours integer DEFAULT 8,
    probation_days integer DEFAULT 90,
    notice_period_days integer DEFAULT 60,
    vacation_days integer DEFAULT 21,
    terms text,
    status text DEFAULT 'active'::text NOT NULL,
    renewed_from_id integer,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: employee_contracts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employee_contracts_id_seq OWNED BY public.employee_contracts.id;


--
-- Name: employee_leaves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_leaves (
    id integer NOT NULL,
    company_id integer NOT NULL,
    employee_id integer NOT NULL,
    leave_type text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days integer DEFAULT 1 NOT NULL,
    paid boolean DEFAULT true NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    approved_by text,
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: employee_leaves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_leaves_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_leaves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employee_leaves_id_seq OWNED BY public.employee_leaves.id;


--
-- Name: employee_loans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_loans (
    id integer NOT NULL,
    company_id integer NOT NULL,
    employee_id integer NOT NULL,
    loan_date date NOT NULL,
    loan_type text DEFAULT 'loan'::text NOT NULL,
    amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    installments integer DEFAULT 1 NOT NULL,
    installment_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    paid_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    reason text,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: employee_loans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_loans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_loans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employee_loans_id_seq OWNED BY public.employee_loans.id;


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    id_type text DEFAULT 'iqama'::text NOT NULL,
    id_number text,
    iqama_expiry date,
    passport_number text,
    passport_expiry date,
    nationality text,
    gender text,
    birth_date date,
    mobile text,
    email text,
    hire_date date,
    end_date date,
    department text,
    job_title text,
    sponsor text,
    profession text,
    status text DEFAULT 'active'::text NOT NULL,
    basic_salary numeric(12,2) DEFAULT '0'::numeric,
    housing_allow numeric(12,2) DEFAULT '0'::numeric,
    transport_allow numeric(12,2) DEFAULT '0'::numeric,
    other_allow numeric(12,2) DEFAULT '0'::numeric,
    bank_account_iban text,
    bank_name text,
    payable_account_id integer,
    photo_url text,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: employees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employees_id_seq OWNED BY public.employees.id;


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id integer NOT NULL,
    company_id integer NOT NULL,
    from_currency_id integer NOT NULL,
    to_currency_id integer NOT NULL,
    rate numeric(18,6) DEFAULT '1'::numeric NOT NULL,
    effective_date text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exchange_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exchange_rates_id_seq OWNED BY public.exchange_rates.id;


--
-- Name: fiscal_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_periods (
    id integer NOT NULL,
    company_id integer NOT NULL,
    fiscal_year_id integer NOT NULL,
    name text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    status public.fiscal_period_status DEFAULT 'open'::public.fiscal_period_status NOT NULL,
    sequence integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: fiscal_periods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fiscal_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fiscal_periods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fiscal_periods_id_seq OWNED BY public.fiscal_periods.id;


--
-- Name: fiscal_years; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_years (
    id integer NOT NULL,
    company_id integer NOT NULL,
    name text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    status public.fiscal_period_status DEFAULT 'open'::public.fiscal_period_status NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: fiscal_years_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fiscal_years_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fiscal_years_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fiscal_years_id_seq OWNED BY public.fiscal_years.id;


--
-- Name: invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_line_items (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    description text NOT NULL,
    quantity numeric(14,4) NOT NULL,
    unit_price numeric(14,2) NOT NULL,
    discount_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    vat_rate numeric(6,2) DEFAULT '15'::numeric NOT NULL,
    vat_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    subtotal numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    unit_code text DEFAULT 'PCE'::text NOT NULL,
    tax_category text DEFAULT 'S'::text NOT NULL
);


--
-- Name: invoice_line_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_line_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_line_items_id_seq OWNED BY public.invoice_line_items.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    company_id integer NOT NULL,
    customer_id integer,
    invoice_number text NOT NULL,
    invoice_type text DEFAULT 'standard'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    issue_date date NOT NULL,
    supply_date date,
    due_date date,
    currency text DEFAULT 'SAR'::text NOT NULL,
    subtotal numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    discount_total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    vat_total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    grand_total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    qr_code text,
    invoice_hash text,
    zatca_status text DEFAULT 'pending'::text,
    zatca_response_code text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    xml_content text,
    invoice_counter_value integer DEFAULT 0,
    previous_invoice_hash text,
    zatca_warning_messages text,
    zatca_error_messages text,
    zatca_clearance_status text,
    payment_method text DEFAULT '10'::text NOT NULL,
    buyer_name text,
    buyer_vat_number text,
    buyer_cr_number text,
    buyer_street text,
    buyer_building_number text,
    buyer_district text,
    buyer_city text,
    buyer_postal_code text,
    buyer_country text DEFAULT 'SA'::text
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: item_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_groups (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    cost_account_id integer,
    revenue_account_id integer
);


--
-- Name: item_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_groups_id_seq OWNED BY public.item_groups.id;


--
-- Name: item_unit_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_unit_prices (
    id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer NOT NULL,
    unit_id integer NOT NULL,
    conversion_factor numeric(14,6) DEFAULT '1'::numeric NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    sale_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    is_base boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: item_unit_prices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.item_unit_prices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: item_unit_prices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.item_unit_prices_id_seq OWNED BY public.item_unit_prices.id;


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id integer NOT NULL,
    company_id integer NOT NULL,
    group_id integer,
    unit_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    barcode text,
    item_type public.item_type DEFAULT 'stock'::public.item_type NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    sale_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    vat_rate numeric(5,2) DEFAULT '15'::numeric NOT NULL,
    reorder_level numeric(14,4) DEFAULT '0'::numeric,
    max_level numeric(14,4),
    cost_method public.cost_method DEFAULT 'weighted_avg'::public.cost_method NOT NULL,
    item_status public.item_status DEFAULT 'active'::public.item_status NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    cost_account_id integer,
    revenue_account_id integer,
    image_url text
);


--
-- Name: items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.items_id_seq OWNED BY public.items.id;


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    entry_date text NOT NULL,
    currency text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(18,6) DEFAULT '1'::numeric NOT NULL,
    description text,
    entry_type text DEFAULT 'general'::text NOT NULL,
    branch_id integer,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: journal_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journal_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journal_entries_id_seq OWNED BY public.journal_entries.id;


--
-- Name: journal_entry_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entry_lines (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    account_id integer,
    cost_center text,
    debit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    credit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: journal_entry_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.journal_entry_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: journal_entry_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.journal_entry_lines_id_seq OWNED BY public.journal_entry_lines.id;


--
-- Name: lc_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lc_expenses (
    id integer NOT NULL,
    lc_id integer NOT NULL,
    company_id integer NOT NULL,
    expense_type text NOT NULL,
    account_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: lc_expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lc_expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lc_expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lc_expenses_id_seq OWNED BY public.lc_expenses.id;


--
-- Name: letters_of_credit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.letters_of_credit (
    id integer NOT NULL,
    company_id integer NOT NULL,
    lc_number text NOT NULL,
    lc_date text NOT NULL,
    supplier_id integer,
    bank_name text,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    used_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status public.lc_status DEFAULT 'open'::public.lc_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: letters_of_credit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.letters_of_credit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: letters_of_credit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.letters_of_credit_id_seq OWNED BY public.letters_of_credit.id;


--
-- Name: notification_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_dismissals (
    notification_id integer NOT NULL,
    user_id integer NOT NULL,
    dismissed_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_reads (
    notification_id integer NOT NULL,
    user_id integer NOT NULL,
    read_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    company_id integer NOT NULL,
    user_id integer,
    title text NOT NULL,
    body text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    source_key text,
    is_read boolean DEFAULT false NOT NULL,
    created_by_user_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    read_at timestamp without time zone
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: payment_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_vouchers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    date text NOT NULL,
    payment_type public.cash_payment_type DEFAULT 'cash'::public.cash_payment_type NOT NULL,
    cash_box_id integer,
    bank_account_id integer,
    entity_type public.cash_entity_type DEFAULT 'supplier'::public.cash_entity_type NOT NULL,
    entity_id integer,
    entity_name text,
    account_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_id integer,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric,
    ref_type text,
    ref_number text,
    description text,
    notes text,
    status public.cash_voucher_status DEFAULT 'draft'::public.cash_voucher_status NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    journal_entry_id integer
);


--
-- Name: payment_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_vouchers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_vouchers_id_seq OWNED BY public.payment_vouchers.id;


--
-- Name: payroll_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_lines (
    id integer NOT NULL,
    payroll_run_id integer NOT NULL,
    employee_id integer NOT NULL,
    basic_salary numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    housing_allow numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    transport_allow numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    other_allow numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    overtime_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    bonus_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    gross_salary numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    gosi_employee numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    loan_deduction numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    absence_deduction numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    other_deduction numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    total_deductions numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    net_salary numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    worked_days integer DEFAULT 30 NOT NULL,
    absent_days integer DEFAULT 0 NOT NULL,
    notes text
);


--
-- Name: payroll_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payroll_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payroll_lines_id_seq OWNED BY public.payroll_lines.id;


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    pay_date date,
    total_gross numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total_deductions numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total_net numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    employees_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    posted_journal_id integer,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: payroll_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payroll_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payroll_runs_id_seq OWNED BY public.payroll_runs.id;


--
-- Name: plan_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_configs (
    id integer NOT NULL,
    key text NOT NULL,
    name_ar text NOT NULL,
    name_en text NOT NULL,
    monthly_price text DEFAULT '0'::text NOT NULL,
    annual_price text DEFAULT '0'::text NOT NULL,
    max_users integer DEFAULT 1 NOT NULL,
    max_invoices integer DEFAULT 50 NOT NULL,
    features text DEFAULT '[]'::text NOT NULL,
    is_recommended boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: plan_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plan_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plan_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plan_configs_id_seq OWNED BY public.plan_configs.id;


--
-- Name: pos_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_sessions (
    id integer NOT NULL,
    company_id integer NOT NULL,
    user_id integer NOT NULL,
    branch_id integer,
    cash_box_id integer,
    opening_cash numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    closing_cash numeric(15,2),
    expected_cash numeric(15,2),
    difference numeric(15,2),
    opened_at timestamp without time zone DEFAULT now() NOT NULL,
    closed_at timestamp without time zone,
    status public.pos_session_status DEFAULT 'open'::public.pos_session_status NOT NULL,
    device text,
    notes text,
    closed_notes text,
    pos_terminal_id integer
);


--
-- Name: pos_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pos_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pos_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pos_sessions_id_seq OWNED BY public.pos_sessions.id;


--
-- Name: pos_terminals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_terminals (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    machine_code text,
    cash_box_id integer,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_terminals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pos_terminals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pos_terminals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pos_terminals_id_seq OWNED BY public.pos_terminals.id;


--
-- Name: purchase_invoice_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_invoice_lines (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    company_id integer NOT NULL,
    item_name text NOT NULL,
    item_code text,
    unit text,
    qty numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    weight numeric(15,4) DEFAULT '0'::numeric,
    unit_price numeric(15,4) DEFAULT '0'::numeric NOT NULL,
    discount numeric(15,2) DEFAULT '0'::numeric,
    vat_rate numeric(5,2) DEFAULT '15'::numeric,
    line_total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    expense_share numeric(15,2) DEFAULT '0'::numeric,
    final_cost numeric(15,2) DEFAULT '0'::numeric,
    account_id integer,
    warehouse_id integer,
    notes text,
    item_id integer,
    unit_id integer,
    conversion_factor numeric(15,6) DEFAULT '1'::numeric
);


--
-- Name: purchase_invoice_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_invoice_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_invoice_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_invoice_lines_id_seq OWNED BY public.purchase_invoice_lines.id;


--
-- Name: purchase_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_invoices (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    invoice_date text NOT NULL,
    supplier_id integer,
    payment_type text DEFAULT 'credit'::text NOT NULL,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    lc_id integer,
    distribution_method public.distribution_method DEFAULT 'value'::public.distribution_method,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    vat_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    discount_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total_expenses_loaded numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status public.purchase_invoice_status DEFAULT 'draft'::public.purchase_invoice_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    cash_box_id integer,
    branch_id integer,
    inventory_account_id integer,
    tax_account_id integer,
    discount_account_id integer,
    journal_entry_id integer,
    price_includes_vat boolean DEFAULT false NOT NULL,
    bank_account_id integer,
    supplier_invoice_number text
);


--
-- Name: purchase_invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_invoices_id_seq OWNED BY public.purchase_invoices.id;


--
-- Name: purchase_return_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_return_lines (
    id integer NOT NULL,
    return_id integer NOT NULL,
    company_id integer NOT NULL,
    item_name text NOT NULL,
    item_code text,
    unit text,
    qty numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    unit_price numeric(15,4) DEFAULT '0'::numeric NOT NULL,
    vat_rate numeric(5,2) DEFAULT '15'::numeric,
    line_total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    item_id integer,
    unit_id integer,
    warehouse_id integer,
    conversion_factor numeric(15,6) DEFAULT '1'::numeric,
    discount numeric(5,2) DEFAULT '0'::numeric NOT NULL
);


--
-- Name: purchase_return_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_return_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_return_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_return_lines_id_seq OWNED BY public.purchase_return_lines.id;


--
-- Name: purchase_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_returns (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    return_date text NOT NULL,
    supplier_id integer,
    invoice_id integer,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    vat_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    payment_type text DEFAULT 'credit'::text NOT NULL,
    cash_box_id integer,
    branch_id integer,
    discount_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    inventory_account_id integer,
    tax_account_id integer,
    discount_account_id integer,
    journal_entry_id integer,
    price_includes_vat boolean DEFAULT false NOT NULL,
    bank_account_id integer,
    supplier_invoice_number text
);


--
-- Name: purchase_returns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_returns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_returns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_returns_id_seq OWNED BY public.purchase_returns.id;


--
-- Name: receipt_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_vouchers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    branch_id integer,
    code text NOT NULL,
    date text NOT NULL,
    payment_type public.cash_payment_type DEFAULT 'cash'::public.cash_payment_type NOT NULL,
    cash_box_id integer,
    bank_account_id integer,
    entity_type public.cash_entity_type DEFAULT 'customer'::public.cash_entity_type NOT NULL,
    entity_id integer,
    entity_name text,
    account_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_id integer,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric,
    ref_type text,
    ref_number text,
    description text,
    notes text,
    status public.cash_voucher_status DEFAULT 'draft'::public.cash_voucher_status NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    journal_entry_id integer
);


--
-- Name: receipt_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receipt_vouchers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipt_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.receipt_vouchers_id_seq OWNED BY public.receipt_vouchers.id;


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    notes text,
    company_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: regions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.regions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.regions_id_seq OWNED BY public.regions.id;


--
-- Name: sales_invoice_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_invoice_lines (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer,
    item_name text NOT NULL,
    item_code text,
    unit text,
    unit_id integer,
    warehouse_id integer,
    qty numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    unit_price numeric(15,4) DEFAULT '0'::numeric NOT NULL,
    discount numeric(15,2) DEFAULT '0'::numeric,
    vat_rate numeric(5,2) DEFAULT '15'::numeric,
    line_total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    conversion_factor numeric(15,6) DEFAULT '1'::numeric
);


--
-- Name: sales_invoice_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_invoice_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_invoice_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_invoice_lines_id_seq OWNED BY public.sales_invoice_lines.id;


--
-- Name: sales_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_invoices (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    invoice_date text NOT NULL,
    customer_id integer,
    payment_type text DEFAULT 'credit'::text NOT NULL,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    vat_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    discount_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status public.sales_invoice_status DEFAULT 'draft'::public.sales_invoice_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    branch_id integer,
    cash_box_id integer,
    cogs_account_id integer,
    inventory_account_id integer,
    sales_account_id integer,
    tax_account_id integer,
    discount_account_id integer,
    journal_entry_id integer,
    zatca_status text DEFAULT 'pending'::text,
    zatca_submitted_at timestamp without time zone,
    zatca_uuid text,
    zatca_response_code text,
    zatca_error_messages text,
    zatca_warning_messages text,
    zatca_ai_suggestion text,
    price_includes_vat boolean DEFAULT false NOT NULL,
    bank_account_id integer,
    pos_session_id integer,
    created_by_id integer
);


--
-- Name: sales_invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_invoices_id_seq OWNED BY public.sales_invoices.id;


--
-- Name: sales_quotation_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_quotation_lines (
    id integer NOT NULL,
    quotation_id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer,
    item_name text NOT NULL,
    item_code text,
    unit text,
    unit_id integer,
    qty numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    unit_price numeric(15,4) DEFAULT '0'::numeric NOT NULL,
    discount numeric(15,2) DEFAULT '0'::numeric,
    vat_rate numeric(5,2) DEFAULT '15'::numeric,
    line_total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text
);


--
-- Name: sales_quotation_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_quotation_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_quotation_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_quotation_lines_id_seq OWNED BY public.sales_quotation_lines.id;


--
-- Name: sales_quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_quotations (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    quotation_date text NOT NULL,
    valid_until text,
    customer_id integer,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    vat_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    discount_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status public.sales_quotation_status DEFAULT 'draft'::public.sales_quotation_status NOT NULL,
    converted_invoice_id integer,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    price_includes_vat boolean DEFAULT false NOT NULL
);


--
-- Name: sales_quotations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_quotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_quotations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_quotations_id_seq OWNED BY public.sales_quotations.id;


--
-- Name: sales_return_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_return_lines (
    id integer NOT NULL,
    return_id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer,
    item_name text NOT NULL,
    item_code text,
    unit text,
    unit_id integer,
    warehouse_id integer,
    qty numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    unit_price numeric(15,4) DEFAULT '0'::numeric NOT NULL,
    vat_rate numeric(5,2) DEFAULT '15'::numeric,
    line_total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    conversion_factor numeric(15,6) DEFAULT '1'::numeric,
    discount numeric(5,2) DEFAULT '0'::numeric NOT NULL
);


--
-- Name: sales_return_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_return_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_return_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_return_lines_id_seq OWNED BY public.sales_return_lines.id;


--
-- Name: sales_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_returns (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    return_date text NOT NULL,
    customer_id integer,
    invoice_id integer,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    total_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    vat_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    branch_id integer,
    payment_type text DEFAULT 'credit'::text NOT NULL,
    cash_box_id integer,
    cogs_account_id integer,
    inventory_account_id integer,
    sales_account_id integer,
    tax_account_id integer,
    discount_account_id integer,
    journal_entry_id integer,
    discount_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    price_includes_vat boolean DEFAULT false NOT NULL,
    bank_account_id integer
);


--
-- Name: sales_returns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_returns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_returns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_returns_id_seq OWNED BY public.sales_returns.id;


--
-- Name: stock_adjustment_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_adjustment_items (
    id integer NOT NULL,
    adjustment_id integer NOT NULL,
    item_id integer NOT NULL,
    unit_id integer,
    qty numeric(18,4) NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    notes text
);


--
-- Name: stock_adjustment_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_adjustment_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_adjustment_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_adjustment_items_id_seq OWNED BY public.stock_adjustment_items.id;


--
-- Name: stock_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_adjustments (
    id integer NOT NULL,
    company_id integer NOT NULL,
    adjustment_number text NOT NULL,
    adjustment_date date NOT NULL,
    warehouse_id integer NOT NULL,
    reason text,
    status public.inv_doc_status DEFAULT 'draft'::public.inv_doc_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    account_id integer,
    inventory_account_id integer,
    adjustment_account_id integer,
    journal_entry_id integer
);


--
-- Name: stock_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_adjustments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_adjustments_id_seq OWNED BY public.stock_adjustments.id;


--
-- Name: stock_balance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_balance (
    id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    qty numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    avg_cost numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_balance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_balance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_balance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_balance_id_seq OWNED BY public.stock_balance.id;


--
-- Name: stock_count_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_count_items (
    id integer NOT NULL,
    count_id integer NOT NULL,
    item_id integer NOT NULL,
    system_qty numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    actual_qty numeric(18,4) NOT NULL,
    diff numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    notes text
);


--
-- Name: stock_count_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_count_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_count_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_count_items_id_seq OWNED BY public.stock_count_items.id;


--
-- Name: stock_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_counts (
    id integer NOT NULL,
    company_id integer NOT NULL,
    count_number text NOT NULL,
    count_date date NOT NULL,
    warehouse_id integer NOT NULL,
    status public.inv_doc_status DEFAULT 'draft'::public.inv_doc_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_counts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_counts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_counts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_counts_id_seq OWNED BY public.stock_counts.id;


--
-- Name: stock_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_ledger (
    id integer NOT NULL,
    company_id integer NOT NULL,
    item_id integer NOT NULL,
    warehouse_id integer NOT NULL,
    tx_date date NOT NULL,
    tx_type public.inv_tx_type NOT NULL,
    qty numeric(18,4) NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL,
    total_cost numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    balance_qty numeric(18,4) DEFAULT '0'::numeric NOT NULL,
    ref_id integer,
    ref_type text,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_ledger_id_seq OWNED BY public.stock_ledger.id;


--
-- Name: stock_transfer_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfer_items (
    id integer NOT NULL,
    transfer_id integer NOT NULL,
    item_id integer NOT NULL,
    unit_id integer,
    qty numeric(18,4) NOT NULL,
    cost_price numeric(14,4) DEFAULT '0'::numeric NOT NULL
);


--
-- Name: stock_transfer_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_transfer_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_transfer_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_transfer_items_id_seq OWNED BY public.stock_transfer_items.id;


--
-- Name: stock_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    transfer_number text NOT NULL,
    transfer_date date NOT NULL,
    from_warehouse_id integer NOT NULL,
    to_warehouse_id integer NOT NULL,
    status public.inv_doc_status DEFAULT 'draft'::public.inv_doc_status NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    account_id integer,
    from_account_id integer,
    to_account_id integer,
    journal_entry_id integer
);


--
-- Name: stock_transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_transfers_id_seq OWNED BY public.stock_transfers.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id integer NOT NULL,
    company_id integer NOT NULL,
    plan text DEFAULT 'starter'::text NOT NULL,
    max_users integer DEFAULT 1 NOT NULL,
    max_invoices integer DEFAULT 50 NOT NULL,
    billing_cycle text DEFAULT 'monthly'::text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    price text DEFAULT '0'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    max_branches integer DEFAULT 1 NOT NULL,
    max_warehouses integer DEFAULT 1 NOT NULL
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;


--
-- Name: supplier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_groups (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    discount_percent numeric(5,2) DEFAULT '0'::numeric,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: supplier_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supplier_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supplier_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supplier_groups_id_seq OWNED BY public.supplier_groups.id;


--
-- Name: supplier_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_settlements (
    id integer NOT NULL,
    company_id integer NOT NULL,
    doc_number text,
    settlement_date text NOT NULL,
    supplier_id integer,
    payment_method text DEFAULT 'bank'::text NOT NULL,
    account_id integer,
    amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    currency_code text DEFAULT 'SAR'::text NOT NULL,
    exchange_rate numeric(15,6) DEFAULT '1'::numeric NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: supplier_settlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supplier_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supplier_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supplier_settlements_id_seq OWNED BY public.supplier_settlements.id;


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id integer NOT NULL,
    company_id integer NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    vat_number text,
    cr_number text,
    email text,
    phone text,
    city text,
    district text,
    street text,
    building_number text,
    postal_code text,
    country text DEFAULT 'SA'::text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    account_id integer,
    group_id integer,
    currency_code text DEFAULT 'SAR'::text,
    credit_limit numeric(15,2) DEFAULT '0'::numeric,
    opening_balance numeric(15,2) DEFAULT '0'::numeric,
    opening_balance_type text DEFAULT 'credit'::text,
    is_active boolean DEFAULT true NOT NULL,
    code text
);


--
-- Name: suppliers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.suppliers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: suppliers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.suppliers_id_seq OWNED BY public.suppliers.id;


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id integer NOT NULL,
    company_id integer,
    user_id integer,
    sender_name text,
    company_name text,
    subject text NOT NULL,
    body text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    admin_reply text,
    admin_reply_at timestamp without time zone,
    resolved_at timestamp without time zone,
    resolved_by_user_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: support_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_messages_id_seq OWNED BY public.support_messages.id;


--
-- Name: support_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_settings (
    id integer NOT NULL,
    in_app_enabled boolean DEFAULT true NOT NULL,
    webhook_enabled boolean DEFAULT false NOT NULL,
    webhook_url text,
    webhook_secret text,
    telegram_enabled boolean DEFAULT false NOT NULL,
    telegram_bot_token text,
    telegram_chat_id text,
    email_enabled boolean DEFAULT false NOT NULL,
    email_recipients text,
    notify_superadmin_in_app boolean DEFAULT true NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_by_user_id integer
);


--
-- Name: support_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_settings_id_seq OWNED BY public.support_settings.id;


--
-- Name: units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.units (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    conversion_factor numeric(14,6) DEFAULT '1'::numeric NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.units_id_seq OWNED BY public.units.id;


--
-- Name: user_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_branches (
    user_id integer NOT NULL,
    branch_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username text NOT NULL,
    email text,
    password_hash text NOT NULL,
    company_id integer,
    role text DEFAULT 'admin'::text NOT NULL,
    session_token text,
    session_id text,
    last_login_at timestamp without time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    code text,
    name_ar text,
    name_en text,
    permissions jsonb
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: warehouse_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_groups (
    id integer NOT NULL,
    company_id integer NOT NULL,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: warehouse_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouse_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouse_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouse_groups_id_seq OWNED BY public.warehouse_groups.id;


--
-- Name: warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouses (
    id integer NOT NULL,
    company_id integer NOT NULL,
    group_id integer,
    code text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    city text,
    region text,
    allow_negative boolean DEFAULT false NOT NULL,
    negative_limit numeric(14,4),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    account_id integer
);


--
-- Name: warehouses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.warehouses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: warehouses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.warehouses_id_seq OWNED BY public.warehouses.id;


--
-- Name: accounting_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_mappings ALTER COLUMN id SET DEFAULT nextval('public.accounting_mappings_id_seq'::regclass);


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: auto_backups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_backups ALTER COLUMN id SET DEFAULT nextval('public.auto_backups_id_seq'::regclass);


--
-- Name: bank_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts ALTER COLUMN id SET DEFAULT nextval('public.bank_accounts_id_seq'::regclass);


--
-- Name: branches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches ALTER COLUMN id SET DEFAULT nextval('public.branches_id_seq'::regclass);


--
-- Name: cash_boxes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes ALTER COLUMN id SET DEFAULT nextval('public.cash_boxes_id_seq'::regclass);


--
-- Name: cash_transfers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers ALTER COLUMN id SET DEFAULT nextval('public.cash_transfers_id_seq'::regclass);


--
-- Name: companies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies ALTER COLUMN id SET DEFAULT nextval('public.companies_id_seq'::regclass);


--
-- Name: cost_centers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centers ALTER COLUMN id SET DEFAULT nextval('public.cost_centers_id_seq'::regclass);


--
-- Name: currencies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies ALTER COLUMN id SET DEFAULT nextval('public.currencies_id_seq'::regclass);


--
-- Name: customer_settlements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settlements ALTER COLUMN id SET DEFAULT nextval('public.customer_settlements_id_seq'::regclass);


--
-- Name: customers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);


--
-- Name: employee_attendance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_attendance ALTER COLUMN id SET DEFAULT nextval('public.employee_attendance_id_seq'::regclass);


--
-- Name: employee_contracts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts ALTER COLUMN id SET DEFAULT nextval('public.employee_contracts_id_seq'::regclass);


--
-- Name: employee_leaves id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_leaves ALTER COLUMN id SET DEFAULT nextval('public.employee_leaves_id_seq'::regclass);


--
-- Name: employee_loans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_loans ALTER COLUMN id SET DEFAULT nextval('public.employee_loans_id_seq'::regclass);


--
-- Name: employees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees ALTER COLUMN id SET DEFAULT nextval('public.employees_id_seq'::regclass);


--
-- Name: exchange_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates ALTER COLUMN id SET DEFAULT nextval('public.exchange_rates_id_seq'::regclass);


--
-- Name: fiscal_periods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_periods ALTER COLUMN id SET DEFAULT nextval('public.fiscal_periods_id_seq'::regclass);


--
-- Name: fiscal_years id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_years ALTER COLUMN id SET DEFAULT nextval('public.fiscal_years_id_seq'::regclass);


--
-- Name: invoice_line_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_line_items_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: item_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_groups ALTER COLUMN id SET DEFAULT nextval('public.item_groups_id_seq'::regclass);


--
-- Name: item_unit_prices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_unit_prices ALTER COLUMN id SET DEFAULT nextval('public.item_unit_prices_id_seq'::regclass);


--
-- Name: items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items ALTER COLUMN id SET DEFAULT nextval('public.items_id_seq'::regclass);


--
-- Name: journal_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries ALTER COLUMN id SET DEFAULT nextval('public.journal_entries_id_seq'::regclass);


--
-- Name: journal_entry_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines ALTER COLUMN id SET DEFAULT nextval('public.journal_entry_lines_id_seq'::regclass);


--
-- Name: lc_expenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_expenses ALTER COLUMN id SET DEFAULT nextval('public.lc_expenses_id_seq'::regclass);


--
-- Name: letters_of_credit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letters_of_credit ALTER COLUMN id SET DEFAULT nextval('public.letters_of_credit_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: payment_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers ALTER COLUMN id SET DEFAULT nextval('public.payment_vouchers_id_seq'::regclass);


--
-- Name: payroll_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines ALTER COLUMN id SET DEFAULT nextval('public.payroll_lines_id_seq'::regclass);


--
-- Name: payroll_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs ALTER COLUMN id SET DEFAULT nextval('public.payroll_runs_id_seq'::regclass);


--
-- Name: plan_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_configs ALTER COLUMN id SET DEFAULT nextval('public.plan_configs_id_seq'::regclass);


--
-- Name: pos_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_sessions ALTER COLUMN id SET DEFAULT nextval('public.pos_sessions_id_seq'::regclass);


--
-- Name: pos_terminals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_terminals ALTER COLUMN id SET DEFAULT nextval('public.pos_terminals_id_seq'::regclass);


--
-- Name: purchase_invoice_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines ALTER COLUMN id SET DEFAULT nextval('public.purchase_invoice_lines_id_seq'::regclass);


--
-- Name: purchase_invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices ALTER COLUMN id SET DEFAULT nextval('public.purchase_invoices_id_seq'::regclass);


--
-- Name: purchase_return_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines ALTER COLUMN id SET DEFAULT nextval('public.purchase_return_lines_id_seq'::regclass);


--
-- Name: purchase_returns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns ALTER COLUMN id SET DEFAULT nextval('public.purchase_returns_id_seq'::regclass);


--
-- Name: receipt_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers ALTER COLUMN id SET DEFAULT nextval('public.receipt_vouchers_id_seq'::regclass);


--
-- Name: regions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions ALTER COLUMN id SET DEFAULT nextval('public.regions_id_seq'::regclass);


--
-- Name: sales_invoice_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoice_lines ALTER COLUMN id SET DEFAULT nextval('public.sales_invoice_lines_id_seq'::regclass);


--
-- Name: sales_invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices ALTER COLUMN id SET DEFAULT nextval('public.sales_invoices_id_seq'::regclass);


--
-- Name: sales_quotation_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotation_lines ALTER COLUMN id SET DEFAULT nextval('public.sales_quotation_lines_id_seq'::regclass);


--
-- Name: sales_quotations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotations ALTER COLUMN id SET DEFAULT nextval('public.sales_quotations_id_seq'::regclass);


--
-- Name: sales_return_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_return_lines ALTER COLUMN id SET DEFAULT nextval('public.sales_return_lines_id_seq'::regclass);


--
-- Name: sales_returns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns ALTER COLUMN id SET DEFAULT nextval('public.sales_returns_id_seq'::regclass);


--
-- Name: stock_adjustment_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustment_items ALTER COLUMN id SET DEFAULT nextval('public.stock_adjustment_items_id_seq'::regclass);


--
-- Name: stock_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments ALTER COLUMN id SET DEFAULT nextval('public.stock_adjustments_id_seq'::regclass);


--
-- Name: stock_balance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balance ALTER COLUMN id SET DEFAULT nextval('public.stock_balance_id_seq'::regclass);


--
-- Name: stock_count_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_items ALTER COLUMN id SET DEFAULT nextval('public.stock_count_items_id_seq'::regclass);


--
-- Name: stock_counts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts ALTER COLUMN id SET DEFAULT nextval('public.stock_counts_id_seq'::regclass);


--
-- Name: stock_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger ALTER COLUMN id SET DEFAULT nextval('public.stock_ledger_id_seq'::regclass);


--
-- Name: stock_transfer_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items ALTER COLUMN id SET DEFAULT nextval('public.stock_transfer_items_id_seq'::regclass);


--
-- Name: stock_transfers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers ALTER COLUMN id SET DEFAULT nextval('public.stock_transfers_id_seq'::regclass);


--
-- Name: subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);


--
-- Name: supplier_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_groups ALTER COLUMN id SET DEFAULT nextval('public.supplier_groups_id_seq'::regclass);


--
-- Name: supplier_settlements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_settlements ALTER COLUMN id SET DEFAULT nextval('public.supplier_settlements_id_seq'::regclass);


--
-- Name: suppliers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers ALTER COLUMN id SET DEFAULT nextval('public.suppliers_id_seq'::regclass);


--
-- Name: support_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages ALTER COLUMN id SET DEFAULT nextval('public.support_messages_id_seq'::regclass);


--
-- Name: support_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_settings ALTER COLUMN id SET DEFAULT nextval('public.support_settings_id_seq'::regclass);


--
-- Name: units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units ALTER COLUMN id SET DEFAULT nextval('public.units_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: warehouse_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_groups ALTER COLUMN id SET DEFAULT nextval('public.warehouse_groups_id_seq'::regclass);


--
-- Name: warehouses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses ALTER COLUMN id SET DEFAULT nextval('public.warehouses_id_seq'::regclass);


--
-- Data for Name: accounting_mappings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.accounting_mappings (id, company_id, document_type, role_key, account_id, is_locked, created_at, updated_at) FROM stdin;
1	5	sales_invoice	revenue	\N	t	2026-04-23 17:43:43.049781	2026-04-23 17:47:40.169
2	5	purchase_invoice	inventory	9	t	2026-04-23 17:45:23.541276	2026-04-23 19:03:33.046
3	5	purchase_invoice	vat_input	\N	t	2026-04-23 17:45:23.551498	2026-04-23 19:03:33.047
4	5	purchase_invoice	payable	\N	t	2026-04-23 17:45:23.558394	2026-04-23 19:03:33.048
5	5	purchase_invoice	discount	\N	t	2026-04-23 17:45:23.566516	2026-04-23 19:03:33.048
23	5	cashbox	cash_on_hand	\N	f	2026-04-23 21:19:10.45381	2026-04-23 21:19:10.45381
\.


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.accounts (id, company_id, parent_id, code, name_ar, name_en, account_type, level, is_posting, is_active, notes, created_at, updated_at, report_direction) FROM stdin;
9	5	\N	1140	مخزون - مخزن رئيسي	\N	asset	1	t	t	\N	2026-04-22 17:53:01.230609	2026-04-22 17:53:01.230609	\N
10	5	\N	1141	مخزون - مخزن الفرع	\N	asset	1	t	t	\N	2026-04-22 17:53:01.356644	2026-04-22 17:53:01.356644	\N
11	5	\N	5910	تسويات مخزنية - تالف وفاقد	Inventory shrinkage	expense	2	t	t	\N	2026-04-22 18:14:48.814023	2026-04-22 18:14:48.814023	\N
12	5	\N	4910	تسويات مخزنية - فائض	Inventory surplus	revenue	2	t	t	\N	2026-04-22 18:14:48.814023	2026-04-22 18:14:48.814023	\N
15	5	\N	2310	دفعات مقدمة من العملاء	Customer Advances	liability	2	t	t	\N	2026-04-22 19:04:20.99114	2026-04-22 19:04:20.99114	\N
16	5	\N	4110	إيرادات المبيعات	Sales Revenue	revenue	2	t	t	\N	2026-04-22 19:04:20.99114	2026-04-22 19:04:20.99114	\N
17	5	\N	4990	إيرادات متنوعة	Other Income	revenue	2	t	t	\N	2026-04-22 19:04:20.99114	2026-04-22 19:04:20.99114	\N
18	5	\N	5210	رواتب وأجور	Salaries & Wages	expense	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
19	5	\N	5310	إيجارات	Rents	expense	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
20	5	\N	5410	مصروفات الكهرباء والماء	Utilities	expense	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
21	5	\N	5990	مصروفات متنوعة	Misc Expenses	expense	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
22	5	\N	1310	دفعات مقدمة للموردين	Advances to Suppliers	asset	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
23	5	\N	2210	قروض قصيرة الأجل	Short-term Loans	liability	2	t	t	\N	2026-04-22 19:15:06.147559	2026-04-22 19:15:06.147559	\N
24	5	\N	1110	الصندوق	Cash on Hand	asset	2	t	t	\N	2026-04-23 01:22:55.204213	2026-04-23 01:22:55.204213	\N
26	5	\N	1132	حساب البنك - الأهلي	Bank - NCB	asset	2	t	t	\N	2026-04-23 01:22:55.204213	2026-04-23 01:22:55.204213	\N
27	5	\N	1133	حساب البنك - بطاقات (POS)	Bank - POS Card	asset	2	t	t	\N	2026-04-23 01:22:55.204213	2026-04-23 01:22:55.204213	\N
25	5	24	1131	حساب البنك - الراجحي	Bank - Rajhi	asset	2	t	t	\N	2026-04-23 01:22:55.204213	2026-04-23 15:12:23.838	\N
14	5	\N	2110	ذمم دائنة - موردين	Accounts Payable	liability	2	f	t	\N	2026-04-22 19:04:20.99114	2026-04-22 19:04:20.99114	\N
29	5	13	1210-001	عميل اختبار حساب 1776965195	\N	asset	3	t	t	\N	2026-04-23 17:26:35.171318	2026-04-23 17:26:35.171318	\N
13	5	\N	1210	ذمم مدينة - عملاء	Accounts Receivable	asset	2	f	t	\N	2026-04-22 19:04:20.99114	2026-04-22 19:04:20.99114	\N
30	5	13	1210-002	عميل اختبار حساب 1776965248	\N	asset	3	t	t	\N	2026-04-23 17:27:28.615962	2026-04-23 17:27:28.615962	\N
31	5	13	1210-003	عميل فحص حساب 1776965292	\N	asset	3	t	t	\N	2026-04-23 17:28:12.79429	2026-04-23 17:28:12.79429	\N
32	5	\N	1140	مخزون - مخزن رئيسي	\N	asset	1	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
33	5	\N	1141	مخزون - مخزن الفرع	\N	asset	1	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
34	5	\N	5910	تسويات مخزنية - تالف وفاقد	Inventory shrinkage	expense	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
35	5	\N	4910	تسويات مخزنية - فائض	Inventory surplus	revenue	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
36	5	\N	2310	دفعات مقدمة من العملاء	Customer Advances	liability	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
37	5	\N	4110	إيرادات المبيعات	Sales Revenue	revenue	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
38	5	\N	4990	إيرادات متنوعة	Other Income	revenue	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
39	5	\N	5210	رواتب وأجور	Salaries & Wages	expense	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
40	5	\N	5310	إيجارات	Rents	expense	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
41	5	\N	5410	مصروفات الكهرباء والماء	Utilities	expense	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
42	5	\N	5990	مصروفات متنوعة	Misc Expenses	expense	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
43	5	\N	1310	دفعات مقدمة للموردين	Advances to Suppliers	asset	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
44	5	\N	2210	قروض قصيرة الأجل	Short-term Loans	liability	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
45	5	\N	1110	الصندوق	Cash on Hand	asset	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
46	5	\N	1132	حساب البنك - الأهلي	Bank - NCB	asset	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
47	5	\N	1133	حساب البنك - بطاقات (POS)	Bank - POS Card	asset	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
48	5	\N	2110	ذمم دائنة - موردين	Accounts Payable	liability	2	f	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
49	5	\N	1210	ذمم مدينة - عملاء	Accounts Receivable	asset	2	f	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
50	5	45	1131	حساب البنك - الراجحي	Bank - Rajhi	asset	2	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
51	5	49	1210-001	عميل اختبار حساب 1776965195	\N	asset	3	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
52	5	49	1210-002	عميل اختبار حساب 1776965248	\N	asset	3	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
53	5	49	1210-003	عميل فحص حساب 1776965292	\N	asset	3	t	t	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N
\.


--
-- Data for Name: auto_backups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auto_backups (id, company_id, created_at, reason, size_bytes, counts, data) FROM stdin;
1	2	2026-04-23 21:59:20.735901	scheduled	540	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [], "customers": [], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 2, "exportedAt": "2026-04-23T21:59:20.734Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
2	4	2026-04-23 21:59:20.798218	scheduled	540	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [], "customers": [], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 4, "exportedAt": "2026-04-23T21:59:20.797Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
3	8	2026-04-23 21:59:20.825318	scheduled	540	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [], "customers": [], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 8, "exportedAt": "2026-04-23T21:59:20.825Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
4	7	2026-04-23 21:59:20.844735	scheduled	540	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [], "customers": [], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 7, "exportedAt": "2026-04-23T21:59:20.844Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
5	1	2026-04-23 21:59:20.863024	scheduled	1145	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 1, "customers": 1, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [{"id": 2, "code": "CASH01", "notes": null, "nameAr": "خزينة الكاشير", "nameEn": null, "branchId": null, "isActive": true, "accountId": null, "companyId": 1, "createdAt": "2026-04-22T23:04:24.622Z", "currencyId": null, "maxBalance": null, "minBalance": "0.00"}], "customers": [{"id": 1, "city": "الرياض", "email": "info@horizon.sa", "phone": "0112345678", "nameAr": "شركة الأفق للتطوير", "nameEn": "Horizon Development Co.", "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 1, "createdAt": "2026-04-18T23:05:45.959Z", "vatNumber": "300000000000003", "postalCode": null, "buildingNumber": null}], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 1, "exportedAt": "2026-04-23T21:59:20.862Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 1, "customers": 1, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
6	3	2026-04-23 21:59:20.880835	scheduled	540	{"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [], "units": [], "regions": [], "accounts": [], "branches": [], "cashBoxes": [], "customers": [], "suppliers": [], "itemGroups": [], "warehouses": [], "bankAccounts": [], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 3, "exportedAt": "2026-04-23T21:59:20.880Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 0, "units": 0, "regions": 0, "accounts": 0, "branches": 0, "cashBoxes": 0, "customers": 0, "suppliers": 0, "itemGroups": 0, "warehouses": 0, "bankAccounts": 0, "supplierGroups": 0, "warehouseGroups": 0}}
7	5	2026-04-23 21:59:20.900799	scheduled	32168	{"items": 4, "units": 4, "regions": 0, "accounts": 44, "branches": 6, "cashBoxes": 4, "customers": 16, "suppliers": 12, "itemGroups": 0, "warehouses": 4, "bankAccounts": 6, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [{"id": 1, "code": "ITM-E2E-01", "nameAr": "صنف اختباري متكامل", "nameEn": "", "status": "active", "unitId": null, "barcode": "", "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-19T17:52:53.316Z", "salePrice": "0.0000", "updatedAt": "2026-04-19T17:52:53.316Z", "costMethod": "weighted_avg", "description": "", "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 2, "code": "DISCOUNTTEST", "nameAr": "DiscountTest", "nameEn": null, "status": "active", "unitId": null, "barcode": null, "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-22T07:50:56.123Z", "salePrice": "0.0000", "updatedAt": "2026-04-22T07:50:56.123Z", "costMethod": "weighted_avg", "description": null, "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 4, "code": "ITM-E2E-01", "nameAr": "صنف اختباري متكامل", "nameEn": "", "status": "active", "unitId": null, "barcode": "", "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-23T21:55:25.701Z", "salePrice": "0.0000", "updatedAt": "2026-04-23T21:55:25.701Z", "costMethod": "weighted_avg", "description": "", "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 5, "code": "DISCOUNTTEST", "nameAr": "DiscountTest", "nameEn": null, "status": "active", "unitId": null, "barcode": null, "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-23T21:55:25.701Z", "salePrice": "0.0000", "updatedAt": "2026-04-23T21:55:25.701Z", "costMethod": "weighted_avg", "description": null, "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}], "units": [{"id": 1, "code": "PCS", "nameAr": "قطعة", "nameEn": "Piece", "companyId": 5, "createdAt": "2026-04-21T09:05:12.655Z", "conversionFactor": "1.000000"}, {"id": 2, "code": "BOX", "nameAr": "علبة", "nameEn": "Box", "companyId": 5, "createdAt": "2026-04-21T09:05:12.703Z", "conversionFactor": "1.000000"}, {"id": 3, "code": "PCS", "nameAr": "قطعة", "nameEn": "Piece", "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "conversionFactor": "1.000000"}, {"id": 4, "code": "BOX", "nameAr": "علبة", "nameEn": "Box", "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "conversionFactor": "1.000000"}], "regions": [], "accounts": [{"id": 9, "code": "1140", "level": 1, "notes": null, "nameAr": "مخزون - مخزن رئيسي", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T17:53:01.230Z", "isPosting": true, "updatedAt": "2026-04-22T17:53:01.230Z", "accountType": "asset", "reportDirection": null}, {"id": 10, "code": "1141", "level": 1, "notes": null, "nameAr": "مخزون - مخزن الفرع", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T17:53:01.356Z", "isPosting": true, "updatedAt": "2026-04-22T17:53:01.356Z", "accountType": "asset", "reportDirection": null}, {"id": 11, "code": "5910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - تالف وفاقد", "nameEn": "Inventory shrinkage", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T18:14:48.814Z", "isPosting": true, "updatedAt": "2026-04-22T18:14:48.814Z", "accountType": "expense", "reportDirection": null}, {"id": 12, "code": "4910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - فائض", "nameEn": "Inventory surplus", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T18:14:48.814Z", "isPosting": true, "updatedAt": "2026-04-22T18:14:48.814Z", "accountType": "revenue", "reportDirection": null}, {"id": 15, "code": "2310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة من العملاء", "nameEn": "Customer Advances", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "liability", "reportDirection": null}, {"id": 16, "code": "4110", "level": 2, "notes": null, "nameAr": "إيرادات المبيعات", "nameEn": "Sales Revenue", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "revenue", "reportDirection": null}, {"id": 17, "code": "4990", "level": 2, "notes": null, "nameAr": "إيرادات متنوعة", "nameEn": "Other Income", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "revenue", "reportDirection": null}, {"id": 18, "code": "5210", "level": 2, "notes": null, "nameAr": "رواتب وأجور", "nameEn": "Salaries & Wages", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 19, "code": "5310", "level": 2, "notes": null, "nameAr": "إيجارات", "nameEn": "Rents", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 20, "code": "5410", "level": 2, "notes": null, "nameAr": "مصروفات الكهرباء والماء", "nameEn": "Utilities", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 21, "code": "5990", "level": 2, "notes": null, "nameAr": "مصروفات متنوعة", "nameEn": "Misc Expenses", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 22, "code": "1310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة للموردين", "nameEn": "Advances to Suppliers", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "asset", "reportDirection": null}, {"id": 23, "code": "2210", "level": 2, "notes": null, "nameAr": "قروض قصيرة الأجل", "nameEn": "Short-term Loans", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "liability", "reportDirection": null}, {"id": 24, "code": "1110", "level": 2, "notes": null, "nameAr": "الصندوق", "nameEn": "Cash on Hand", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 26, "code": "1132", "level": 2, "notes": null, "nameAr": "حساب البنك - الأهلي", "nameEn": "Bank - NCB", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 27, "code": "1133", "level": 2, "notes": null, "nameAr": "حساب البنك - بطاقات (POS)", "nameEn": "Bank - POS Card", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 25, "code": "1131", "level": 2, "notes": null, "nameAr": "حساب البنك - الراجحي", "nameEn": "Bank - Rajhi", "isActive": true, "parentId": 24, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T15:12:23.838Z", "accountType": "asset", "reportDirection": null}, {"id": 14, "code": "2110", "level": 2, "notes": null, "nameAr": "ذمم دائنة - موردين", "nameEn": "Accounts Payable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": false, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "liability", "reportDirection": null}, {"id": 29, "code": "1210-001", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:26:35.171Z", "isPosting": true, "updatedAt": "2026-04-23T17:26:35.171Z", "accountType": "asset", "reportDirection": null}, {"id": 13, "code": "1210", "level": 2, "notes": null, "nameAr": "ذمم مدينة - عملاء", "nameEn": "Accounts Receivable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": false, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "asset", "reportDirection": null}, {"id": 30, "code": "1210-002", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:27:28.615Z", "isPosting": true, "updatedAt": "2026-04-23T17:27:28.615Z", "accountType": "asset", "reportDirection": null}, {"id": 31, "code": "1210-003", "level": 3, "notes": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:28:12.794Z", "isPosting": true, "updatedAt": "2026-04-23T17:28:12.794Z", "accountType": "asset", "reportDirection": null}, {"id": 32, "code": "1140", "level": 1, "notes": null, "nameAr": "مخزون - مخزن رئيسي", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 33, "code": "1141", "level": 1, "notes": null, "nameAr": "مخزون - مخزن الفرع", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 34, "code": "5910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - تالف وفاقد", "nameEn": "Inventory shrinkage", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 35, "code": "4910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - فائض", "nameEn": "Inventory surplus", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 36, "code": "2310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة من العملاء", "nameEn": "Customer Advances", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 37, "code": "4110", "level": 2, "notes": null, "nameAr": "إيرادات المبيعات", "nameEn": "Sales Revenue", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 38, "code": "4990", "level": 2, "notes": null, "nameAr": "إيرادات متنوعة", "nameEn": "Other Income", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 39, "code": "5210", "level": 2, "notes": null, "nameAr": "رواتب وأجور", "nameEn": "Salaries & Wages", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 40, "code": "5310", "level": 2, "notes": null, "nameAr": "إيجارات", "nameEn": "Rents", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 41, "code": "5410", "level": 2, "notes": null, "nameAr": "مصروفات الكهرباء والماء", "nameEn": "Utilities", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 42, "code": "5990", "level": 2, "notes": null, "nameAr": "مصروفات متنوعة", "nameEn": "Misc Expenses", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 43, "code": "1310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة للموردين", "nameEn": "Advances to Suppliers", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 44, "code": "2210", "level": 2, "notes": null, "nameAr": "قروض قصيرة الأجل", "nameEn": "Short-term Loans", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 45, "code": "1110", "level": 2, "notes": null, "nameAr": "الصندوق", "nameEn": "Cash on Hand", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 46, "code": "1132", "level": 2, "notes": null, "nameAr": "حساب البنك - الأهلي", "nameEn": "Bank - NCB", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 47, "code": "1133", "level": 2, "notes": null, "nameAr": "حساب البنك - بطاقات (POS)", "nameEn": "Bank - POS Card", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 48, "code": "2110", "level": 2, "notes": null, "nameAr": "ذمم دائنة - موردين", "nameEn": "Accounts Payable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": false, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 49, "code": "1210", "level": 2, "notes": null, "nameAr": "ذمم مدينة - عملاء", "nameEn": "Accounts Receivable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": false, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 50, "code": "1131", "level": 2, "notes": null, "nameAr": "حساب البنك - الراجحي", "nameEn": "Bank - Rajhi", "isActive": true, "parentId": 45, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 51, "code": "1210-001", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 52, "code": "1210-002", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 53, "code": "1210-003", "level": 3, "notes": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}], "branches": [{"id": 1, "city": null, "code": "B001", "email": null, "notes": null, "phone": null, "isMain": true, "nameAr": "الفرع الرئيسي", "nameEn": "Main Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-21T08:12:47.667Z", "updatedAt": "2026-04-21T08:12:47.667Z"}, {"id": 2, "city": null, "code": "B002", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرع جدة", "nameEn": "Jeddah Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-21T08:12:47.667Z", "updatedAt": "2026-04-21T08:12:47.667Z"}, {"id": 4, "city": null, "code": "BR-0001", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرعx7lX95", "nameEn": null, "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T08:18:42.246Z", "updatedAt": "2026-04-23T08:18:42.246Z"}, {"id": 5, "city": null, "code": "B001", "email": null, "notes": null, "phone": null, "isMain": true, "nameAr": "الفرع الرئيسي", "nameEn": "Main Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}, {"id": 6, "city": null, "code": "B002", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرع جدة", "nameEn": "Jeddah Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}, {"id": 7, "city": null, "code": "BR-0001", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرعx7lX95", "nameEn": null, "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}], "cashBoxes": [{"id": 1, "code": "TST-92990", "notes": "", "nameAr": "خزنة اختبار التحقق", "nameEn": "", "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-21T07:21:27.002Z", "currencyId": null, "maxBalance": "2000.00", "minBalance": "500.00"}, {"id": 4, "code": "CB-0001", "notes": null, "nameAr": "خزنة اختبار f9Qyw", "nameEn": null, "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T08:11:34.895Z", "currencyId": null, "maxBalance": null, "minBalance": "0.00"}, {"id": 6, "code": "TST-92990", "notes": "", "nameAr": "خزنة اختبار التحقق", "nameEn": "", "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "currencyId": null, "maxBalance": "2000.00", "minBalance": "500.00"}, {"id": 7, "code": "CB-0001", "notes": null, "nameAr": "خزنة اختبار f9Qyw", "nameEn": null, "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "currencyId": null, "maxBalance": null, "minBalance": "0.00"}], "customers": [{"id": 2, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": 1, "companyId": 5, "createdAt": "2026-04-21T08:35:38.058Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 3, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T17:26:35.254Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 4, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T17:27:28.622Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 5, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 31, "companyId": 5, "createdAt": "2026-04-23T17:28:12.810Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 6, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 7, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 8, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 9, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 31, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 10, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 11, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 12, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 13, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 53, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 14, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 15, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 16, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 17, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 53, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}], "suppliers": [{"id": 1, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-21T08:35:23.685Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 3, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T15:59:03.819Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 4, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T16:01:30.525Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 6, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 7, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 8, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 9, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 10, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 11, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 12, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 13, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 14, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}], "itemGroups": [], "warehouses": [{"id": 1, "city": "", "code": "WH-E2E-01", "nameAr": "مخزن الاختبار الشامل", "nameEn": "", "region": "", "groupId": null, "isActive": true, "accountId": 1, "companyId": 5, "createdAt": "2026-04-19T17:52:19.289Z", "allowNegative": false, "negativeLimit": null}, {"id": 2, "city": null, "code": "WH-AI-02", "nameAr": "مخزن الفرع الثاني (اختبار AI)", "nameEn": null, "region": null, "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-22T17:52:35.612Z", "allowNegative": false, "negativeLimit": null}, {"id": 3, "city": "", "code": "WH-E2E-01", "nameAr": "مخزن الاختبار الشامل", "nameEn": "", "region": "", "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "allowNegative": false, "negativeLimit": null}, {"id": 4, "city": null, "code": "WH-AI-02", "nameAr": "مخزن الفرع الثاني (اختبار AI)", "nameEn": null, "region": null, "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "allowNegative": false, "negativeLimit": null}], "bankAccounts": [{"id": 2, "code": "BA-CARD", "iban": null, "notes": null, "nameAr": "POS - شبكة (مدى)", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 27, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-CARD-001"}, {"id": 3, "code": "BA-AP", "iban": null, "notes": null, "nameAr": "POS - Apple Pay", "nameEn": null, "bankName": "الأهلي", "branchId": null, "isActive": true, "accountId": 26, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-AP-001"}, {"id": 4, "code": "BA-WAL", "iban": null, "notes": null, "nameAr": "POS - محفظة", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 25, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-WALLET-001"}, {"id": 7, "code": "BA-CARD", "iban": null, "notes": null, "nameAr": "POS - شبكة (مدى)", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 47, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-CARD-001"}, {"id": 8, "code": "BA-AP", "iban": null, "notes": null, "nameAr": "POS - Apple Pay", "nameEn": null, "bankName": "الأهلي", "branchId": null, "isActive": true, "accountId": 46, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-AP-001"}, {"id": 9, "code": "BA-WAL", "iban": null, "notes": null, "nameAr": "POS - محفظة", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 50, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-WALLET-001"}], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 5, "exportedAt": "2026-04-23T21:59:20.899Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 4, "units": 4, "regions": 0, "accounts": 44, "branches": 6, "cashBoxes": 4, "customers": 16, "suppliers": 12, "itemGroups": 0, "warehouses": 4, "bankAccounts": 6, "supplierGroups": 0, "warehouseGroups": 0}}
8	5	2026-04-23 21:59:26.185867	manual	32168	{"items": 4, "units": 4, "regions": 0, "accounts": 44, "branches": 6, "cashBoxes": 4, "customers": 16, "suppliers": 12, "itemGroups": 0, "warehouses": 4, "bankAccounts": 6, "supplierGroups": 0, "warehouseGroups": 0}	{"data": {"items": [{"id": 1, "code": "ITM-E2E-01", "nameAr": "صنف اختباري متكامل", "nameEn": "", "status": "active", "unitId": null, "barcode": "", "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-19T17:52:53.316Z", "salePrice": "0.0000", "updatedAt": "2026-04-19T17:52:53.316Z", "costMethod": "weighted_avg", "description": "", "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 2, "code": "DISCOUNTTEST", "nameAr": "DiscountTest", "nameEn": null, "status": "active", "unitId": null, "barcode": null, "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-22T07:50:56.123Z", "salePrice": "0.0000", "updatedAt": "2026-04-22T07:50:56.123Z", "costMethod": "weighted_avg", "description": null, "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 4, "code": "ITM-E2E-01", "nameAr": "صنف اختباري متكامل", "nameEn": "", "status": "active", "unitId": null, "barcode": "", "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-23T21:55:25.701Z", "salePrice": "0.0000", "updatedAt": "2026-04-23T21:55:25.701Z", "costMethod": "weighted_avg", "description": "", "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}, {"id": 5, "code": "DISCOUNTTEST", "nameAr": "DiscountTest", "nameEn": null, "status": "active", "unitId": null, "barcode": null, "groupId": null, "vatRate": "15.00", "imageUrl": null, "itemType": "stock", "maxLevel": null, "companyId": 5, "costPrice": "0.0000", "createdAt": "2026-04-23T21:55:25.701Z", "salePrice": "0.0000", "updatedAt": "2026-04-23T21:55:25.701Z", "costMethod": "weighted_avg", "description": null, "reorderLevel": "0.0000", "costAccountId": null, "revenueAccountId": null}], "units": [{"id": 1, "code": "PCS", "nameAr": "قطعة", "nameEn": "Piece", "companyId": 5, "createdAt": "2026-04-21T09:05:12.655Z", "conversionFactor": "1.000000"}, {"id": 2, "code": "BOX", "nameAr": "علبة", "nameEn": "Box", "companyId": 5, "createdAt": "2026-04-21T09:05:12.703Z", "conversionFactor": "1.000000"}, {"id": 3, "code": "PCS", "nameAr": "قطعة", "nameEn": "Piece", "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "conversionFactor": "1.000000"}, {"id": 4, "code": "BOX", "nameAr": "علبة", "nameEn": "Box", "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "conversionFactor": "1.000000"}], "regions": [], "accounts": [{"id": 9, "code": "1140", "level": 1, "notes": null, "nameAr": "مخزون - مخزن رئيسي", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T17:53:01.230Z", "isPosting": true, "updatedAt": "2026-04-22T17:53:01.230Z", "accountType": "asset", "reportDirection": null}, {"id": 10, "code": "1141", "level": 1, "notes": null, "nameAr": "مخزون - مخزن الفرع", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T17:53:01.356Z", "isPosting": true, "updatedAt": "2026-04-22T17:53:01.356Z", "accountType": "asset", "reportDirection": null}, {"id": 11, "code": "5910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - تالف وفاقد", "nameEn": "Inventory shrinkage", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T18:14:48.814Z", "isPosting": true, "updatedAt": "2026-04-22T18:14:48.814Z", "accountType": "expense", "reportDirection": null}, {"id": 12, "code": "4910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - فائض", "nameEn": "Inventory surplus", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T18:14:48.814Z", "isPosting": true, "updatedAt": "2026-04-22T18:14:48.814Z", "accountType": "revenue", "reportDirection": null}, {"id": 15, "code": "2310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة من العملاء", "nameEn": "Customer Advances", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "liability", "reportDirection": null}, {"id": 16, "code": "4110", "level": 2, "notes": null, "nameAr": "إيرادات المبيعات", "nameEn": "Sales Revenue", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "revenue", "reportDirection": null}, {"id": 17, "code": "4990", "level": 2, "notes": null, "nameAr": "إيرادات متنوعة", "nameEn": "Other Income", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": true, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "revenue", "reportDirection": null}, {"id": 18, "code": "5210", "level": 2, "notes": null, "nameAr": "رواتب وأجور", "nameEn": "Salaries & Wages", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 19, "code": "5310", "level": 2, "notes": null, "nameAr": "إيجارات", "nameEn": "Rents", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 20, "code": "5410", "level": 2, "notes": null, "nameAr": "مصروفات الكهرباء والماء", "nameEn": "Utilities", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 21, "code": "5990", "level": 2, "notes": null, "nameAr": "مصروفات متنوعة", "nameEn": "Misc Expenses", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "expense", "reportDirection": null}, {"id": 22, "code": "1310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة للموردين", "nameEn": "Advances to Suppliers", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "asset", "reportDirection": null}, {"id": 23, "code": "2210", "level": 2, "notes": null, "nameAr": "قروض قصيرة الأجل", "nameEn": "Short-term Loans", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:15:06.147Z", "isPosting": true, "updatedAt": "2026-04-22T19:15:06.147Z", "accountType": "liability", "reportDirection": null}, {"id": 24, "code": "1110", "level": 2, "notes": null, "nameAr": "الصندوق", "nameEn": "Cash on Hand", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 26, "code": "1132", "level": 2, "notes": null, "nameAr": "حساب البنك - الأهلي", "nameEn": "Bank - NCB", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 27, "code": "1133", "level": 2, "notes": null, "nameAr": "حساب البنك - بطاقات (POS)", "nameEn": "Bank - POS Card", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T01:22:55.204Z", "accountType": "asset", "reportDirection": null}, {"id": 25, "code": "1131", "level": 2, "notes": null, "nameAr": "حساب البنك - الراجحي", "nameEn": "Bank - Rajhi", "isActive": true, "parentId": 24, "companyId": 5, "createdAt": "2026-04-23T01:22:55.204Z", "isPosting": true, "updatedAt": "2026-04-23T15:12:23.838Z", "accountType": "asset", "reportDirection": null}, {"id": 14, "code": "2110", "level": 2, "notes": null, "nameAr": "ذمم دائنة - موردين", "nameEn": "Accounts Payable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": false, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "liability", "reportDirection": null}, {"id": 29, "code": "1210-001", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:26:35.171Z", "isPosting": true, "updatedAt": "2026-04-23T17:26:35.171Z", "accountType": "asset", "reportDirection": null}, {"id": 13, "code": "1210", "level": 2, "notes": null, "nameAr": "ذمم مدينة - عملاء", "nameEn": "Accounts Receivable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-22T19:04:20.991Z", "isPosting": false, "updatedAt": "2026-04-22T19:04:20.991Z", "accountType": "asset", "reportDirection": null}, {"id": 30, "code": "1210-002", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:27:28.615Z", "isPosting": true, "updatedAt": "2026-04-23T17:27:28.615Z", "accountType": "asset", "reportDirection": null}, {"id": 31, "code": "1210-003", "level": 3, "notes": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "isActive": true, "parentId": 13, "companyId": 5, "createdAt": "2026-04-23T17:28:12.794Z", "isPosting": true, "updatedAt": "2026-04-23T17:28:12.794Z", "accountType": "asset", "reportDirection": null}, {"id": 32, "code": "1140", "level": 1, "notes": null, "nameAr": "مخزون - مخزن رئيسي", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 33, "code": "1141", "level": 1, "notes": null, "nameAr": "مخزون - مخزن الفرع", "nameEn": null, "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 34, "code": "5910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - تالف وفاقد", "nameEn": "Inventory shrinkage", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 35, "code": "4910", "level": 2, "notes": null, "nameAr": "تسويات مخزنية - فائض", "nameEn": "Inventory surplus", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 36, "code": "2310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة من العملاء", "nameEn": "Customer Advances", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 37, "code": "4110", "level": 2, "notes": null, "nameAr": "إيرادات المبيعات", "nameEn": "Sales Revenue", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 38, "code": "4990", "level": 2, "notes": null, "nameAr": "إيرادات متنوعة", "nameEn": "Other Income", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "revenue", "reportDirection": null}, {"id": 39, "code": "5210", "level": 2, "notes": null, "nameAr": "رواتب وأجور", "nameEn": "Salaries & Wages", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 40, "code": "5310", "level": 2, "notes": null, "nameAr": "إيجارات", "nameEn": "Rents", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 41, "code": "5410", "level": 2, "notes": null, "nameAr": "مصروفات الكهرباء والماء", "nameEn": "Utilities", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 42, "code": "5990", "level": 2, "notes": null, "nameAr": "مصروفات متنوعة", "nameEn": "Misc Expenses", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "expense", "reportDirection": null}, {"id": 43, "code": "1310", "level": 2, "notes": null, "nameAr": "دفعات مقدمة للموردين", "nameEn": "Advances to Suppliers", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 44, "code": "2210", "level": 2, "notes": null, "nameAr": "قروض قصيرة الأجل", "nameEn": "Short-term Loans", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 45, "code": "1110", "level": 2, "notes": null, "nameAr": "الصندوق", "nameEn": "Cash on Hand", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 46, "code": "1132", "level": 2, "notes": null, "nameAr": "حساب البنك - الأهلي", "nameEn": "Bank - NCB", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 47, "code": "1133", "level": 2, "notes": null, "nameAr": "حساب البنك - بطاقات (POS)", "nameEn": "Bank - POS Card", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 48, "code": "2110", "level": 2, "notes": null, "nameAr": "ذمم دائنة - موردين", "nameEn": "Accounts Payable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": false, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "liability", "reportDirection": null}, {"id": 49, "code": "1210", "level": 2, "notes": null, "nameAr": "ذمم مدينة - عملاء", "nameEn": "Accounts Receivable", "isActive": true, "parentId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": false, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 50, "code": "1131", "level": 2, "notes": null, "nameAr": "حساب البنك - الراجحي", "nameEn": "Bank - Rajhi", "isActive": true, "parentId": 45, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 51, "code": "1210-001", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 52, "code": "1210-002", "level": 3, "notes": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}, {"id": 53, "code": "1210-003", "level": 3, "notes": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "isActive": true, "parentId": 49, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "isPosting": true, "updatedAt": "2026-04-23T21:55:25.701Z", "accountType": "asset", "reportDirection": null}], "branches": [{"id": 1, "city": null, "code": "B001", "email": null, "notes": null, "phone": null, "isMain": true, "nameAr": "الفرع الرئيسي", "nameEn": "Main Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-21T08:12:47.667Z", "updatedAt": "2026-04-21T08:12:47.667Z"}, {"id": 2, "city": null, "code": "B002", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرع جدة", "nameEn": "Jeddah Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-21T08:12:47.667Z", "updatedAt": "2026-04-21T08:12:47.667Z"}, {"id": 4, "city": null, "code": "BR-0001", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرعx7lX95", "nameEn": null, "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T08:18:42.246Z", "updatedAt": "2026-04-23T08:18:42.246Z"}, {"id": 5, "city": null, "code": "B001", "email": null, "notes": null, "phone": null, "isMain": true, "nameAr": "الفرع الرئيسي", "nameEn": "Main Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}, {"id": 6, "city": null, "code": "B002", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرع جدة", "nameEn": "Jeddah Branch", "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}, {"id": 7, "city": null, "code": "BR-0001", "email": null, "notes": null, "phone": null, "isMain": false, "nameAr": "فرعx7lX95", "nameEn": null, "status": "active", "address": null, "regionId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "updatedAt": "2026-04-23T21:55:25.701Z"}], "cashBoxes": [{"id": 1, "code": "TST-92990", "notes": "", "nameAr": "خزنة اختبار التحقق", "nameEn": "", "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-21T07:21:27.002Z", "currencyId": null, "maxBalance": "2000.00", "minBalance": "500.00"}, {"id": 4, "code": "CB-0001", "notes": null, "nameAr": "خزنة اختبار f9Qyw", "nameEn": null, "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T08:11:34.895Z", "currencyId": null, "maxBalance": null, "minBalance": "0.00"}, {"id": 6, "code": "TST-92990", "notes": "", "nameAr": "خزنة اختبار التحقق", "nameEn": "", "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "currencyId": null, "maxBalance": "2000.00", "minBalance": "500.00"}, {"id": 7, "code": "CB-0001", "notes": null, "nameAr": "خزنة اختبار f9Qyw", "nameEn": null, "branchId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "currencyId": null, "maxBalance": null, "minBalance": "0.00"}], "customers": [{"id": 2, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": 1, "companyId": 5, "createdAt": "2026-04-21T08:35:38.058Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 3, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T17:26:35.254Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 4, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T17:27:28.622Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 5, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 31, "companyId": 5, "createdAt": "2026-04-23T17:28:12.810Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 6, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 7, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 8, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 9, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 31, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 10, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 11, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 12, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 13, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 53, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}, {"id": 14, "city": "جدة", "email": "edit@test.com", "phone": "0555555555", "nameAr": "عميل تجريبي معدل-2 - تجربة", "nameEn": "Edited Test", "street": "", "country": "SA", "crNumber": "", "district": "", "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "", "postalCode": "", "buildingNumber": ""}, {"id": 15, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965195", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300012345678903", "postalCode": null, "buildingNumber": null}, {"id": 16, "city": null, "email": null, "phone": null, "nameAr": "عميل اختبار حساب 1776965248", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "buildingNumber": null}, {"id": 17, "city": null, "email": null, "phone": null, "nameAr": "عميل فحص حساب 1776965292", "nameEn": null, "street": null, "country": "SA", "crNumber": null, "district": null, "accountId": 53, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "300055555555553", "postalCode": null, "buildingNumber": null}], "suppliers": [{"id": 1, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-21T08:35:23.685Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 3, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T15:59:03.819Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 4, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T16:01:30.525Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 6, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 7, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 8, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:54:25.316Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 9, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 10, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 11, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 12, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": null, "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 13, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222223", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}, {"id": 14, "city": null, "code": null, "email": null, "phone": null, "nameAr": "مورد اختبار سريع TEST-QA-RET-3", "nameEn": null, "street": null, "country": "SA", "groupId": null, "crNumber": null, "district": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "vatNumber": "312222222222225", "postalCode": null, "creditLimit": "0.00", "currencyCode": "SAR", "buildingNumber": null, "openingBalance": "0.00", "openingBalanceType": "credit"}], "itemGroups": [], "warehouses": [{"id": 1, "city": "", "code": "WH-E2E-01", "nameAr": "مخزن الاختبار الشامل", "nameEn": "", "region": "", "groupId": null, "isActive": true, "accountId": 1, "companyId": 5, "createdAt": "2026-04-19T17:52:19.289Z", "allowNegative": false, "negativeLimit": null}, {"id": 2, "city": null, "code": "WH-AI-02", "nameAr": "مخزن الفرع الثاني (اختبار AI)", "nameEn": null, "region": null, "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-22T17:52:35.612Z", "allowNegative": false, "negativeLimit": null}, {"id": 3, "city": "", "code": "WH-E2E-01", "nameAr": "مخزن الاختبار الشامل", "nameEn": "", "region": "", "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "allowNegative": false, "negativeLimit": null}, {"id": 4, "city": null, "code": "WH-AI-02", "nameAr": "مخزن الفرع الثاني (اختبار AI)", "nameEn": null, "region": null, "groupId": null, "isActive": true, "accountId": null, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "allowNegative": false, "negativeLimit": null}], "bankAccounts": [{"id": 2, "code": "BA-CARD", "iban": null, "notes": null, "nameAr": "POS - شبكة (مدى)", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 27, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-CARD-001"}, {"id": 3, "code": "BA-AP", "iban": null, "notes": null, "nameAr": "POS - Apple Pay", "nameEn": null, "bankName": "الأهلي", "branchId": null, "isActive": true, "accountId": 26, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-AP-001"}, {"id": 4, "code": "BA-WAL", "iban": null, "notes": null, "nameAr": "POS - محفظة", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 25, "companyId": 5, "createdAt": "2026-04-23T01:23:34.254Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-WALLET-001"}, {"id": 7, "code": "BA-CARD", "iban": null, "notes": null, "nameAr": "POS - شبكة (مدى)", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 47, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-CARD-001"}, {"id": 8, "code": "BA-AP", "iban": null, "notes": null, "nameAr": "POS - Apple Pay", "nameEn": null, "bankName": "الأهلي", "branchId": null, "isActive": true, "accountId": 46, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-AP-001"}, {"id": 9, "code": "BA-WAL", "iban": null, "notes": null, "nameAr": "POS - محفظة", "nameEn": null, "bankName": "الراجحي", "branchId": null, "isActive": true, "accountId": 50, "companyId": 5, "createdAt": "2026-04-23T21:55:25.701Z", "swiftCode": null, "bankNameEn": null, "currencyId": null, "accountNumber": "POS-WALLET-001"}], "supplierGroups": [], "warehouseGroups": []}, "meta": {"appName": "ZATCA Invoicing", "companyId": 5, "exportedAt": "2026-04-23T21:59:26.184Z", "exportedBy": "scheduler", "schemaVersion": 1}, "counts": {"items": 4, "units": 4, "regions": 0, "accounts": 44, "branches": 6, "cashBoxes": 4, "customers": 16, "suppliers": 12, "itemGroups": 0, "warehouses": 4, "bankAccounts": 6, "supplierGroups": 0, "warehouseGroups": 0}}
\.


--
-- Data for Name: bank_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bank_accounts (id, company_id, branch_id, code, name_ar, name_en, bank_name, bank_name_en, account_number, iban, swift_code, currency_id, account_id, is_active, notes, created_at) FROM stdin;
2	5	\N	BA-CARD	POS - شبكة (مدى)	\N	الراجحي	\N	POS-CARD-001	\N	\N	\N	27	t	\N	2026-04-23 01:23:34.254179
3	5	\N	BA-AP	POS - Apple Pay	\N	الأهلي	\N	POS-AP-001	\N	\N	\N	26	t	\N	2026-04-23 01:23:34.254179
4	5	\N	BA-WAL	POS - محفظة	\N	الراجحي	\N	POS-WALLET-001	\N	\N	\N	25	t	\N	2026-04-23 01:23:34.254179
7	5	\N	BA-CARD	POS - شبكة (مدى)	\N	الراجحي	\N	POS-CARD-001	\N	\N	\N	47	t	\N	2026-04-23 21:55:25.701214
8	5	\N	BA-AP	POS - Apple Pay	\N	الأهلي	\N	POS-AP-001	\N	\N	\N	46	t	\N	2026-04-23 21:55:25.701214
9	5	\N	BA-WAL	POS - محفظة	\N	الراجحي	\N	POS-WALLET-001	\N	\N	\N	50	t	\N	2026-04-23 21:55:25.701214
\.


--
-- Data for Name: branches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.branches (id, code, name_ar, name_en, region_id, company_id, city, address, phone, email, is_main, status, notes, created_at, updated_at) FROM stdin;
1	B001	الفرع الرئيسي	Main Branch	\N	5	\N	\N	\N	\N	t	active	\N	2026-04-21 08:12:47.667615	2026-04-21 08:12:47.667615
2	B002	فرع جدة	Jeddah Branch	\N	5	\N	\N	\N	\N	f	active	\N	2026-04-21 08:12:47.667615	2026-04-21 08:12:47.667615
4	BR-0001	فرعx7lX95	\N	\N	5	\N	\N	\N	\N	f	active	\N	2026-04-23 08:18:42.24668	2026-04-23 08:18:42.24668
5	B001	الفرع الرئيسي	Main Branch	\N	5	\N	\N	\N	\N	t	active	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214
6	B002	فرع جدة	Jeddah Branch	\N	5	\N	\N	\N	\N	f	active	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214
7	BR-0001	فرعx7lX95	\N	\N	5	\N	\N	\N	\N	f	active	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214
\.


--
-- Data for Name: cash_boxes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cash_boxes (id, company_id, branch_id, code, name_ar, name_en, currency_id, account_id, min_balance, max_balance, is_active, notes, created_at) FROM stdin;
1	5	\N	TST-92990	خزنة اختبار التحقق		\N	\N	500.00	2000.00	t		2026-04-21 07:21:27.00258
2	1	\N	CASH01	خزينة الكاشير	\N	\N	\N	0.00	\N	t	\N	2026-04-22 23:04:24.622947
4	5	\N	CB-0001	خزنة اختبار f9Qyw	\N	\N	\N	0.00	\N	t	\N	2026-04-23 08:11:34.895855
6	5	\N	TST-92990	خزنة اختبار التحقق		\N	\N	500.00	2000.00	t		2026-04-23 21:55:25.701214
7	5	\N	CB-0001	خزنة اختبار f9Qyw	\N	\N	\N	0.00	\N	t	\N	2026-04-23 21:55:25.701214
\.


--
-- Data for Name: cash_transfers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cash_transfers (id, company_id, code, date, transfer_type, from_cash_box_id, from_bank_id, to_cash_box_id, to_bank_id, amount, currency_id, exchange_rate, description, notes, status, created_at) FROM stdin;
\.


--
-- Data for Name: companies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.companies (id, name_ar, name_en, vat_number, cr_number, city, district, street, building_number, postal_code, additional_number, country, industry_name, invoice_type, is_sandbox, serial_number, device_serial1, device_serial2, device_serial3, zatca_csid, zatca_pcsid, created_at, updated_at, zatca_private_key, zatca_csr, zatca_csid_token, zatca_csid_secret, zatca_pcsid_token, zatca_pcsid_secret, invoice_counter, status, rejection_reason, registration_ip, menu_permissions, logo, decimal_places, hr_salaries_expense_account_id, hr_allowances_expense_account_id, hr_gosi_expense_account_id, hr_eos_expense_account_id, hr_salaries_payable_account_id, hr_gosi_payable_account_id, hr_other_deductions_account_id, hr_employee_loans_account_id, hr_eos_provision_account_id, hr_default_pay_cashbox_id, hr_default_pay_bank_account_id, pos_cash_cashbox_id, pos_card_bank_account_id, pos_apple_bank_account_id, pos_wallet_bank_account_id, auto_posting_enabled, auto_backup_enabled, auto_backup_frequency_hours, auto_backup_retention, last_auto_backup_at) FROM stdin;
4	شركة التجربة الثانية	\N	310025263300113	1010000099	جدة	\N	شارع الستين	9999	21422	\N	SA	\N	both	f	\N	\N	\N	\N	\N	\N	2026-04-19 02:02:42.393339	2026-04-19 02:02:42.393339	\N	\N	\N	\N	\N	\N	0	active	\N	\N	{"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.804
8	مؤسسة الخليج للأعمال	\N	3200000000300004	9876543210	جدة	الحمدانية	شارع الملك	2200	21589	\N	SA	\N	both	f	\N	\N	\N	\N	\N	\N	2026-04-19 02:22:22.960267	2026-04-19 02:22:22.960267	\N	\N	\N	\N	\N	\N	0	pending	\N	\N	{"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.832
7	شركة النجم للتقنية	Al-Najm Technology Co.	3100000000200003	1234567890	الرياض	العليا	شارع التقنية	1001	12345	\N	SA	\N	both	t	1-Server|2-Node|3-7	\N	\N	\N	\N	\N	2026-04-19 02:22:22.544155	2026-04-19 11:17:54.091	-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIMnIwR62sjgR4P3JuSSepBwFVberm0GzBpC70FRi/V4doAcGBSuBBAAK\noUQDQgAEFKS0N6qSELFKJUgS4igImM8MI2klX1izWKG9EyjYGm4kZ0/EyhSIAQ2N\noMnpu2mvKI9N+sllKNwDMGgDrD6bCA==\n-----END EC PRIVATE KEY-----\n	-----BEGIN CERTIFICATE REQUEST-----\nMIICQjCCAecCAQAwgYwxCzAJBgNVBAYTAlNBMRIwEAYDVQQLDAlFLUludm9pY2Ux\nSzBJBgNVBAoMQsOYwrTDmMKxw5nCg8OYwqkgw5jCp8OZwoTDmcKGw5jCrMOZwoUg\nw5nChMOZwoTDmMKqw5nCgsOZwobDmcKKw5jCqTEcMBoGA1UEAwwTMS1TZXJ2ZXJ8\nMi1Ob2RlfDMtNzBWMBAGByqGSM49AgEGBSuBBAAKA0IABBSktDeqkhCxSiVIEuIo\nCJjPDCNpJV9Ys1ihvRMo2BpuJGdPxMoUiAENjaDJ6btpryiPTfrJZSjcAzBoA6w+\nmwiggfowgfcGCSqGSIb3DQEJDjGB6TCB5jAbBgNVHREEFDAShhAzMTAwMDAwMDAw\nMjAwMDAzMDEGCSsGAQQBgjcUAgQkDCJaQVRDQV9FLUludm9pY2VfU29sdXRpb25z\nX1Byb3ZpZGVyMCAGCmCGSAGG+mwKAQwEEgwQMzEwMDAwMDAwMDIwMDAwMzAjBgpg\nhkgBhvpsCgELBBUMEzEtU2VydmVyfDItTm9kZXwzLTcwFAYKYIZIAYb6bAoBDQQG\nDAQxMTAwMBEGCmCGSAGG+mwKAQ4EAwwBMTARBgpghkgBhvpsCgEPBAMMATEwEQYK\nYIZIAYb6bAoBBwQDDAExMAoGCCqGSM49BAMCA0kAMEYCIQCa/OmU3QB+xFpXcRn0\nXdKIFJfTiPtONnBxFN9UoN7UAgIhAImKCzKEsKQks2SwGDraRFx0qmjIaIuZk8J2\nOZmlUcUi\n-----END CERTIFICATE REQUEST-----\n	\N	\N	\N	\N	0	pending	\N	\N	{"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.851
1	شركة التقنية المتقدمة	Advanced Tech Company	310025263300003	1010000001	الرياض	العليا	طريق الملك فهد	1234	12211	\N	SA	تقنية المعلومات	both	f	1-Device|2-2354|3-UqazDistserialnumber	Device	2354	UqazDistserialnumber	\N	\N	2026-04-18 23:05:39.076736	2026-04-19 12:16:59.932	\N	\N	\N	\N	\N	\N	0	active	\N	\N	{"dashboard":true,"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.869
3	شركة الاختبار للتجارة	Test Trading Co.	310025263300003	1010000001	الرياض	\N	طريق الملك فهد	1234	12211	\N	SA	\N	both	f	\N	\N	\N	\N	\N	\N	2026-04-19 02:02:09.379587	2026-04-23 00:25:24.063	\N	\N	\N	\N	\N	\N	0	active	\N	\N	{"dashboard":true,"invoices":true,"customers":true,"suppliers":true,"reports":true,"inventory_mobile":true,"inventory_reports":true,"sales_module":true,"sales_reports":true,"purchases_module":true,"purchases_reports":true,"pos":true,"cash_module":true,"cash_reports":true,"accounts":true,"accounting_reports":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.887
2	مؤسسة التجارة الذكية	Smart Trade Est.	310025263300099	2050000002	جدة	الروضة	شارع الأمير محمد	5678	23455	\N	SA	التجزئة	simplified	t	\N	\N	\N	\N	\N	\N	2026-04-18 23:05:45.914629	2026-04-19 01:11:09.476	-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIFPestaeVPsbhYsYGbkpGcO+UJkHqspAqiICp/MoI4vEoAcGBSuBBAAK\noUQDQgAE/Ks8IQbMjFVSD5YdADoYLllpKvrxXJO4pjMT3YhEB2d2g3no8uqTtM2m\n7b3i+JhqoWlnPtiPymPa4dLcM//CaQ==\n-----END EC PRIVATE KEY-----\n	-----BEGIN CERTIFICATE REQUEST-----\nMIICXzCCAgUCAQAwgacxCzAJBgNVBAYTAlNBMSUwIwYDVQQLDBzDmMKnw5nChMOY\nwqrDmMKsw5jCssOYwqbDmMKpMVMwUQYDVQQKDErDmcKFw5jCpMOYwrPDmMKzw5jC\nqSDDmMKnw5nChMOYwqrDmMKsw5jCp8OYwrHDmMKpIMOYwqfDmcKEw5jCsMOZwoPD\nmcKKw5jCqTEcMBoGA1UEAwwTMS1TZXJ2ZXJ8Mi1Ob2RlfDMtMjBWMBAGByqGSM49\nAgEGBSuBBAAKA0IABPyrPCEGzIxVUg+WHQA6GC5ZaSr68VyTuKYzE92IRAdndoN5\n6PLqk7TNpu294viYaqFpZz7Yj8pj2uHS3DP/wmmggf0wgfoGCSqGSIb3DQEJDjGB\n7DCB6TAaBgNVHREEEzARhg8zMTAwMjUyNjMzMDAwOTkwNgYJKwYBBAGCNxQCBCkM\nJ1pBVENBX0UtSW52b2ljZV9Tb2x1dGlvbnNfUHJvdmlkZXJfRGVtbzAfBgpghkgB\nhvpsCgEMBBEMDzMxMDAyNTI2MzMwMDA5OTAjBgpghkgBhvpsCgELBBUMEzEtU2Vy\ndmVyfDItTm9kZXwzLTIwFAYKYIZIAYb6bAoBDQQGDAQxMDAwMBEGCmCGSAGG+mwK\nAQ4EAwwBMTARBgpghkgBhvpsCgEPBAMMATEwEQYKYIZIAYb6bAoBBwQDDAExMAoG\nCCqGSM49BAMCA0gAMEUCIQCVy4B1xK8vJGFM26HcS7OvPz+LMsC8LwGK+PuuAIxt\n+gIgV8RYkkVvTU8cADcoe9VMQ7+2PlQE8NnJ+0+Jw6xCVKg=\n-----END CERTIFICATE REQUEST-----\n	\N	\N	\N	\N	0	active	\N	\N	{"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	t	t	24	7	2026-04-23 21:59:20.785
5	alazzam	alazzam	5657676767676	87878787	alridh	\N	street mohamed	22222	12344	\N	SA	\N	both	t	1-Server|2-Node|3-5				\N	\N	2026-04-19 02:07:21.34578	2026-04-23 07:39:02.941	-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIJ2cen/UiqqGXf9JnvRhwmw5tbINFXeT1AWv088C8grfoAcGBSuBBAAK\noUQDQgAEcR1qchjX2lKaZ/IRbVTIVxAxpS88i2bSU68O7QSdjAJsyLWvlH8WkXLo\n9EDdsQ0pgGisCKjmsB2yIAycHUHe9g==\n-----END EC PRIVATE KEY-----\n	-----BEGIN CERTIFICATE REQUEST-----\nMIICBTCCAaoCAQAwUTELMAkGA1UEBhMCU0ExEjAQBgNVBAsMCUUtSW52b2ljZTEQ\nMA4GA1UECgwHYWxhenphbTEcMBoGA1UEAwwTMS1TZXJ2ZXJ8Mi1Ob2RlfDMtNTBW\nMBAGByqGSM49AgEGBSuBBAAKA0IABHEdanIY19pSmmfyEW1UyFcQMaUvPItm0lOv\nDu0EnYwCbMi1r5R/FpFy6PRA3bENKYBorAio5rAdsiAMnB1B3vaggfkwgfYGCSqG\nSIb3DQEJDjGB6DCB5TAYBgNVHREEETAPhg01NjU3Njc2NzY3Njc2MDYGCSsGAQQB\ngjcUAgQpDCdaQVRDQV9FLUludm9pY2VfU29sdXRpb25zX1Byb3ZpZGVyX0RlbW8w\nHQYKYIZIAYb6bAoBDAQPDA01NjU3Njc2NzY3Njc2MCMGCmCGSAGG+mwKAQsEFQwT\nMS1TZXJ2ZXJ8Mi1Ob2RlfDMtNTAUBgpghkgBhvpsCgENBAYMBDExMDAwEQYKYIZI\nAYb6bAoBDgQDDAExMBEGCmCGSAGG+mwKAQ8EAwwBMTARBgpghkgBhvpsCgEHBAMM\nATEwCgYIKoZIzj0EAwIDSQAwRgIhANkOoC7lGaHoSWdb0xun21HkzvCvzTattUL0\ndnOB8E94AiEArp3GmOry5ebHWqXLMeAPCZ6PT4fIRg6R3qljKVYy7p4=\n-----END CERTIFICATE REQUEST-----\n	\N	\N	\N	\N	0	active	\N	\N	{"dashboard":true,"invoices":true,"customers":true,"suppliers":true,"zatca":true}	\N	2	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	1	\N	3	4	t	t	24	7	2026-04-23 21:59:26.193
\.


--
-- Data for Name: cost_centers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cost_centers (id, company_id, parent_id, code, name_ar, name_en, level, is_posting, is_active, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: currencies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.currencies (id, company_id, code, name_ar, name_en, symbol, is_default, is_active, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: customer_settlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customer_settlements (id, company_id, doc_number, settlement_date, customer_id, payment_method, account_id, amount, currency_code, exchange_rate, status, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customers (id, company_id, name_ar, name_en, vat_number, cr_number, email, phone, city, district, street, building_number, postal_code, country, created_at, account_id) FROM stdin;
1	1	شركة الأفق للتطوير	Horizon Development Co.	300000000000003	\N	info@horizon.sa	0112345678	الرياض	\N	\N	\N	\N	SA	2026-04-18 23:05:45.959621	\N
2	5	عميل تجريبي معدل-2 - تجربة	Edited Test			edit@test.com	0555555555	جدة					SA	2026-04-21 08:35:38.05869	1
3	5	عميل اختبار حساب 1776965195	\N	300012345678903	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 17:26:35.254892	\N
4	5	عميل اختبار حساب 1776965248	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 17:27:28.62241	\N
5	5	عميل فحص حساب 1776965292	\N	300055555555553	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 17:28:12.81004	31
6	5	عميل تجريبي معدل-2 - تجربة	Edited Test			edit@test.com	0555555555	جدة					SA	2026-04-23 21:54:25.316869	\N
7	5	عميل اختبار حساب 1776965195	\N	300012345678903	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	\N
8	5	عميل اختبار حساب 1776965248	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	\N
9	5	عميل فحص حساب 1776965292	\N	300055555555553	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	31
10	5	عميل تجريبي معدل-2 - تجربة	Edited Test			edit@test.com	0555555555	جدة					SA	2026-04-23 21:55:25.701214	\N
11	5	عميل اختبار حساب 1776965195	\N	300012345678903	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N
12	5	عميل اختبار حساب 1776965248	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N
13	5	عميل فحص حساب 1776965292	\N	300055555555553	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	53
14	5	عميل تجريبي معدل-2 - تجربة	Edited Test			edit@test.com	0555555555	جدة					SA	2026-04-23 21:55:25.701214	\N
15	5	عميل اختبار حساب 1776965195	\N	300012345678903	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N
16	5	عميل اختبار حساب 1776965248	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N
17	5	عميل فحص حساب 1776965292	\N	300055555555553	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	53
\.


--
-- Data for Name: employee_attendance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_attendance (id, company_id, employee_id, date, check_in, check_out, worked_hours, overtime_hours, late_minutes, status, notes, created_at, updated_at) FROM stdin;
1	5	1	2026-04-22	08:15	18:30	8.00	2.25	0	present	\N	2026-04-22 19:46:14.333379	2026-04-22 19:46:14.333379
\.


--
-- Data for Name: employee_contracts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_contracts (id, company_id, employee_id, contract_number, contract_type, start_date, end_date, basic_salary, housing_allow, transport_allow, other_allow, working_hours, probation_days, notice_period_days, vacation_days, terms, status, renewed_from_id, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: employee_leaves; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_leaves (id, company_id, employee_id, leave_type, start_date, end_date, days, paid, status, reason, approved_by, approved_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: employee_loans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_loans (id, company_id, employee_id, loan_date, loan_type, amount, installments, installment_amount, paid_amount, status, reason, notes, created_at, updated_at) FROM stdin;
1	5	1	2026-04-01	loan	3000.00	6	500.00	0.00	active	ظرف عائلي	\N	2026-04-22 19:46:14.418072	2026-04-22 19:46:14.418072
\.


--
-- Data for Name: employees; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employees (id, company_id, branch_id, code, name_ar, name_en, id_type, id_number, iqama_expiry, passport_number, passport_expiry, nationality, gender, birth_date, mobile, email, hire_date, end_date, department, job_title, sponsor, profession, status, basic_salary, housing_allow, transport_allow, other_allow, bank_account_iban, bank_name, payable_account_id, photo_url, notes, created_at, updated_at) FROM stdin;
1	5	\N	EMP-0001	محمد أحمد	Mohammed Ahmed	iqama	2345678901	2026-05-10	\N	\N	مصري	\N	\N	0551234567	\N	2019-01-15	\N	\N	محاسب	\N	\N	active	5000.00	1500.00	500.00	0.00	\N	\N	\N	\N	\N	2026-04-22 19:29:50.88836	2026-04-22 19:46:14.537
\.


--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.exchange_rates (id, company_id, from_currency_id, to_currency_id, rate, effective_date, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: fiscal_periods; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_periods (id, company_id, fiscal_year_id, name, start_date, end_date, status, sequence, created_at, updated_at) FROM stdin;
2	5	1	فبراير 2026	2026-02-01	2026-02-28	open	2	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
3	5	1	مارس 2026	2026-03-01	2026-03-31	open	3	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
4	5	1	أبريل 2026	2026-04-01	2026-04-30	open	4	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
5	5	1	مايو 2026	2026-05-01	2026-05-31	open	5	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
6	5	1	يونيو 2026	2026-06-01	2026-06-30	open	6	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
7	5	1	يوليو 2026	2026-07-01	2026-07-31	open	7	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
8	5	1	أغسطس 2026	2026-08-01	2026-08-31	open	8	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
9	5	1	سبتمبر 2026	2026-09-01	2026-09-30	open	9	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
10	5	1	أكتوبر 2026	2026-10-01	2026-10-31	open	10	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
11	5	1	نوفمبر 2026	2026-11-01	2026-11-30	open	11	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
12	5	1	ديسمبر 2026	2026-12-01	2026-12-31	open	12	2026-04-22 06:52:00.928002	2026-04-22 06:52:00.928002
1	5	1	يناير 2026	2026-01-01	2026-01-31	open	1	2026-04-22 06:52:00.928002	2026-04-22 06:53:51.523
41	5	5	يناير 2028	2028-01-01	2028-01-31	open	1	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
42	5	5	فبراير 2028	2028-02-01	2028-02-29	open	2	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
43	5	5	مارس 2028	2028-03-01	2028-03-31	open	3	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
44	5	5	أبريل 2028	2028-04-01	2028-04-30	open	4	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
45	5	5	مايو 2028	2028-05-01	2028-05-31	open	5	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
46	5	5	يونيو 2028	2028-06-01	2028-06-30	open	6	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
47	5	5	يوليو 2028	2028-07-01	2028-07-31	open	7	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
48	5	5	أغسطس 2028	2028-08-01	2028-08-31	open	8	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
49	5	5	سبتمبر 2028	2028-09-01	2028-09-30	open	9	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
50	5	5	أكتوبر 2028	2028-10-01	2028-10-31	open	10	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
51	5	5	نوفمبر 2028	2028-11-01	2028-11-30	open	11	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
52	5	5	ديسمبر 2028	2028-12-01	2028-12-31	open	12	2026-04-23 19:16:11.84253	2026-04-23 19:16:11.84253
\.


--
-- Data for Name: fiscal_years; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fiscal_years (id, company_id, name, start_date, end_date, status, created_at, updated_at) FROM stdin;
1	5	السنة المالية 2026	2026-01-01	2026-12-31	open	2026-04-22 06:52:00.911835	2026-04-22 06:52:00.911835
5	5	سنة تجريبية 2028	2028-01-01	2028-12-31	open	2026-04-23 19:16:11.832133	2026-04-23 19:16:11.832133
\.


--
-- Data for Name: invoice_line_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.invoice_line_items (id, invoice_id, description, quantity, unit_price, discount_amount, vat_rate, vat_amount, subtotal, total, unit_code, tax_category) FROM stdin;
1	1	استشارات تقنية	5.0000	2000.00	0.00	15.00	1500.00	10000.00	11500.00	PCE	S
2	1	تطوير تطبيق ويب	1.0000	15000.00	0.00	15.00	2250.00	15000.00	17250.00	PCE	S
3	2	صيانة أنظمة	2.0000	3500.00	0.00	15.00	1050.00	7000.00	8050.00	PCE	S
4	3	بضاعة مباعة	10.0000	500.00	0.00	15.00	750.00	5000.00	5750.00	PCE	S
5	4	خدمة	1.0000	0.00	0.00	15.00	0.00	0.00	0.00	PCE	S
6	5	11	1.0000	0.00	0.00	15.00	0.00	0.00	0.00	PCE	S
\.


--
-- Data for Name: invoices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.invoices (id, company_id, customer_id, invoice_number, invoice_type, status, issue_date, supply_date, due_date, currency, subtotal, discount_total, vat_total, grand_total, notes, qr_code, invoice_hash, zatca_status, zatca_response_code, created_at, updated_at, xml_content, invoice_counter_value, previous_invoice_hash, zatca_warning_messages, zatca_error_messages, zatca_clearance_status, payment_method, buyer_name, buyer_vat_number, buyer_cr_number, buyer_street, buyer_building_number, buyer_district, buyer_city, buyer_postal_code, buyer_country) FROM stdin;
2	1	1	INV-2026-1-759223	simplified	draft	2026-04-10	\N	\N	SAR	7000.00	0.00	1050.00	8050.00	\N	\N	\N	pending	\N	2026-04-18 23:05:51.896158	2026-04-18 23:05:51.896158	\N	0	\N	\N	\N	\N	10	\N	\N	\N	\N	\N	\N	\N	\N	SA
1	1	1	INV-2026-1-375947	standard	issued	2026-04-01	\N	\N	SAR	25000.00	0.00	3750.00	28750.00	\N	2LTYsdmD2Kkg2KfZhNiq2YLZhtmK2Kkg2KfZhNmF2KrZgtiv2YXYqXwzMTAwMjUyNjMzMDAwMDN8MjAyNi0wNC0wMXwyODc1MC4wMHwzNzUwLjAw	e2f4885a09ba94f6e048b85be8bdd4d59ea9d614fbf01900cbec38ad808c8a5a	reported	\N	2026-04-18 23:05:51.829567	2026-04-18 23:05:57.667	\N	0	\N	\N	\N	\N	10	\N	\N	\N	\N	\N	\N	\N	\N	SA
3	2	\N	INV-2026-2-801408	simplified	draft	2026-03-15	\N	\N	SAR	5000.00	0.00	750.00	5750.00	\N	\N	\N	pending	\N	2026-04-18 23:05:57.721412	2026-04-18 23:05:57.721412	\N	0	\N	\N	\N	\N	10	\N	\N	\N	\N	\N	\N	\N	\N	SA
4	5	\N	INV-2026-5-139869	standard	draft	2026-04-22	\N	\N	SAR	0.00	0.00	0.00	0.00	\N	\N	\N	pending	\N	2026-04-22 10:44:00.967004	2026-04-22 10:44:00.967004	\N	0	\N	\N	\N	\N	10	\N	\N	\N	\N	\N	\N	\N	\N	SA
5	5	\N	INV-2026-5-869715	standard	draft	2026-04-22	\N	\N	SAR	0.00	0.00	0.00	0.00	\N	\N	\N	pending	\N	2026-04-22 10:54:31.329122	2026-04-22 10:54:31.329122	\N	0	\N	\N	\N	\N	10	\N	\N	\N	\N	\N	\N	\N	\N	SA
\.


--
-- Data for Name: item_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_groups (id, company_id, code, name_ar, name_en, created_at, cost_account_id, revenue_account_id) FROM stdin;
\.


--
-- Data for Name: item_unit_prices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_unit_prices (id, company_id, item_id, unit_id, conversion_factor, cost_price, sale_price, is_base, created_at) FROM stdin;
1	5	1	1	1.000000	5.0000	10.0000	t	2026-04-21 09:05:32.67746
2	5	1	2	12.000000	55.0000	110.0000	f	2026-04-21 09:05:32.730024
\.


--
-- Data for Name: items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.items (id, company_id, group_id, unit_id, code, name_ar, name_en, barcode, item_type, cost_price, sale_price, vat_rate, reorder_level, max_level, cost_method, item_status, description, created_at, updated_at, cost_account_id, revenue_account_id, image_url) FROM stdin;
1	5	\N	\N	ITM-E2E-01	صنف اختباري متكامل			stock	0.0000	0.0000	15.00	0.0000	\N	weighted_avg	active		2026-04-19 17:52:53.316695	2026-04-19 17:52:53.316695	\N	\N	\N
2	5	\N	\N	DISCOUNTTEST	DiscountTest	\N	\N	stock	0.0000	0.0000	15.00	0.0000	\N	weighted_avg	active	\N	2026-04-22 07:50:56.123126	2026-04-22 07:50:56.123126	\N	\N	\N
4	5	\N	\N	ITM-E2E-01	صنف اختباري متكامل			stock	0.0000	0.0000	15.00	0.0000	\N	weighted_avg	active		2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N	\N	\N
5	5	\N	\N	DISCOUNTTEST	DiscountTest	\N	\N	stock	0.0000	0.0000	15.00	0.0000	\N	weighted_avg	active	\N	2026-04-23 21:55:25.701214	2026-04-23 21:55:25.701214	\N	\N	\N
\.


--
-- Data for Name: journal_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.journal_entries (id, company_id, doc_number, entry_date, currency, exchange_rate, description, entry_type, branch_id, status, created_at, updated_at) FROM stdin;
1	5	TRF-1776880398900	2026-04-22	SAR	1.000000	تحويل مخزني TRF-1776880398900 - اختبار قيد AI	stock_transfer	\N	posted	2026-04-22 17:53:19.041786	2026-04-22 17:53:19.041786
2	5	TRF-1776880607837	2026-04-22	SAR	1.000000	تحويل مخزني TRF-1776880607837	stock_transfer	\N	posted	2026-04-22 17:56:47.974256	2026-04-22 17:56:47.974256
3	5	ADJ-JE-ADJ-1776881719024	2026-04-22	SAR	1.000000	قيد تسوية مخزنية: ADJ-1776881719024 — تلف وخسارة	stock_adjustment	\N	posted	2026-04-22 18:15:19.160366	2026-04-22 18:15:19.160366
\.


--
-- Data for Name: journal_entry_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.journal_entry_lines (id, entry_id, account_id, cost_center, debit, credit, description, sort_order) FROM stdin;
1	1	10	\N	50.00	0.00	استلام بالمخزن (TRF-1776880398900)	0
2	1	9	\N	0.00	50.00	صرف من المخزن (TRF-1776880398900)	1
3	2	10	\N	20.00	0.00	استلام بالمخزن (TRF-1776880607837)	0
4	2	9	\N	0.00	20.00	صرف من المخزن (TRF-1776880607837)	1
5	3	11	\N	30.00	0.00	تسوية — عجز/تالف مخزون	0
6	3	9	\N	0.00	30.00	نقص مخزون — مخزن الاختبار الشامل	1
\.


--
-- Data for Name: lc_expenses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.lc_expenses (id, lc_id, company_id, expense_type, account_id, amount, currency_code, notes, created_at) FROM stdin;
\.


--
-- Data for Name: letters_of_credit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.letters_of_credit (id, company_id, lc_number, lc_date, supplier_id, bank_name, currency_code, total_amount, used_amount, status, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: notification_dismissals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_dismissals (notification_id, user_id, dismissed_at) FROM stdin;
8	3	2026-04-23 11:52:46.467128
9	3	2026-04-23 11:55:13.38927
10	3	2026-04-23 11:55:32.558065
\.


--
-- Data for Name: notification_reads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_reads (notification_id, user_id, read_at) FROM stdin;
3	9	2026-04-23 10:58:21.525197
3	3	2026-04-23 11:43:48.094964
5	3	2026-04-23 11:43:48.094964
10	3	2026-04-23 11:55:27.208455
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, company_id, user_id, title, body, severity, category, source_key, is_read, created_by_user_id, created_at, read_at) FROM stdin;
7	5	4	رسالة دعم جديدة: اختبار من الواجهة	**من:** karm (alazzam)\n\nهذا اختبار للنظام الجديد للرسائل	info	support_message	support_message:3	f	3	2026-04-23 11:28:05.629118	\N
8	5	\N	تنبيه تجريبي 1	لاختبار الحذف.	medium	general	\N	f	\N	2026-04-23 11:51:01.32602	\N
3	5	\N	[5] فواتير مبيعات مرحّلة بدون قيد محاسبي	# تنبيه إلى مدير الشركة\n\n## المشكلة\nتم رصد **فواتير مبيعات مرحّلة بدون قيد محاسبي** في شركة **alazzam** ضمن شاشة **فواتير المبيعات**.  \nهذا يعني أن الفواتير تم اعتمادها أو ترحيلها تشغيلياً، لكن لم يُثبت أثرها في اليومية المحاسبية.\n\n## الأثر\n- يؤدي ذلك إلى **نقص أو تشوه في تسجيل الإيرادات والذمم المدينة** في القوائم المالية.\n- قد يسبب **عدم تطابق** بين تقارير المبيعات والحسابات العامة.\n- إذا كانت الفواتير مرتبطة بحركة صنفية، فقد يظهر **اختلاف بين أثر البيع المحاسبي والحركة التشغيلية للمخزون**.\n\n## خطوات الحل\n1. الدخول إلى شاشة **فواتير المبيعات**.\n2. تصفية الفواتير المرحّلة ومراجعة السجلات المتأثرة المذكورة في التنبيه.\n3. التحقق من وجود **قيد محاسبي** مرتبط بكل فاتورة.\n4. للفواتير التي لا تحتوي على قيد، تنفيذ **إعادة الترحيل المحاسبي** أو **إنشاء القيد المحاسبي** وفق آلية النظام المعتمدة.\n5. مراجعة إعدادات **الربط بين فواتير المبيعات واليومية** للتأكد من عدم تكرار المشكلة.\n6. مطابقة نتائج المعالجة مع **تقارير المبيعات** و**دفتر الأستاذ** والتأكد من اكتمال الأثر المحاسبي لجميع الفواتير المتأثرة.	high	ai_diagnostic	sales_invoices_without_je	f	4	2026-04-23 10:56:33.655013	\N
4	5	4	رسالة دعم جديدة: اختبار	**من:** karm (alazzam)\n\nهذه رسالة تجريبية	high	support_message	support_message:1	f	3	2026-04-23 11:21:25.583512	\N
5	5	3	رد على رسالتك: اختبار	**رد الإدارة:**\n\nشكراً، سنتابع معك	info	support_reply	support_reply:1	f	4	2026-04-23 11:21:25.614516	\N
6	5	4	رسالة دعم جديدة: اختبار من الواجهة	**من:** karm (alazzam)\n\nهذا اختبار للنظام الجديد للرسائل	high	support_message	support_message:2	f	3	2026-04-23 11:26:32.790674	\N
9	5	\N	تنبيه تجريبي 2	لاختبار العد التنازلي.	high	ai_diagnostic	\N	f	\N	2026-04-23 11:51:01.32602	\N
10	5	\N	تنبيه تجريبي 3	تنبيه ثالث.	low	general	\N	f	\N	2026-04-23 11:51:01.32602	\N
\.


--
-- Data for Name: payment_vouchers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_vouchers (id, company_id, branch_id, code, date, payment_type, cash_box_id, bank_account_id, entity_type, entity_id, entity_name, account_id, amount, currency_id, exchange_rate, ref_type, ref_number, description, notes, status, created_at, journal_entry_id) FROM stdin;
1	5	1	PV-0001	2026-04-21	cash	1	\N	supplier	1	\N	\N	115.00	\N	1.000000	purchase_invoice	3	صرف نقدي للفاتورة رقم 3	\N	posted	2026-04-21 08:35:23.831571	\N
2	5	\N	PV-0002	2026-04-21	cash	\N	\N	supplier	\N		\N	50.00	\N	1.000000					draft	2026-04-21 11:46:36.153302	\N
\.


--
-- Data for Name: payroll_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payroll_lines (id, payroll_run_id, employee_id, basic_salary, housing_allow, transport_allow, other_allow, overtime_amount, bonus_amount, gross_salary, gosi_employee, loan_deduction, absence_deduction, other_deduction, total_deductions, net_salary, worked_days, absent_days, notes) FROM stdin;
\.


--
-- Data for Name: payroll_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payroll_runs (id, company_id, branch_id, code, year, month, period_start, period_end, pay_date, total_gross, total_deductions, total_net, employees_count, status, posted_journal_id, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: plan_configs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plan_configs (id, key, name_ar, name_en, monthly_price, annual_price, max_users, max_invoices, features, is_recommended, is_active, sort_order, updated_at) FROM stdin;
1	starter	مبتدئ	Starter	99	990	1	50	["مستخدم واحد","50 فاتورة شهرياً","فواتير ضريبية ومبسطة","دعم بريد إلكتروني"]	f	t	1	2026-04-19 07:27:56.327746
2	professional	احترافي	Professional	299	2990	5	500	["5 مستخدمين","500 فاتورة شهرياً","تقارير متقدمة","API مفتوح","دعم أولوية"]	t	t	2	2026-04-19 07:27:56.327746
3	enterprise	مؤسسي	Enterprise	899	8990	999	999999	["مستخدمون غير محدودين","فواتير غير محدودة","تقارير مخصصة","SLA 99.9%","مدير حساب مخصص"]	f	t	3	2026-04-19 07:27:56.327746
\.


--
-- Data for Name: pos_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pos_sessions (id, company_id, user_id, branch_id, cash_box_id, opening_cash, closing_cash, expected_cash, difference, opened_at, closed_at, status, device, notes, closed_notes, pos_terminal_id) FROM stdin;
2	3	1	\N	\N	75.00	75.00	75.00	0.00	2026-04-22 23:51:45.814655	2026-04-22 23:52:04.114	closed	test-device	\N	إغلاق من لوحة المراقبة	\N
1	5	3	\N	\N	100.00	100.00	100.00	0.00	2026-04-22 23:47:29.899795	2026-04-22 23:56:37.876	closed	test-device	\N	إغلاق من لوحة المراقبة	\N
3	5	3	\N	\N	0.00	\N	\N	\N	2026-04-23 01:27:26.457649	2026-04-23 13:11:34.211995	force_closed	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36	\N	\N	\N
4	5	3	1	\N	0.00	0.00	0.00	0.00	2026-04-23 13:13:36.280238	2026-04-23 13:22:23.342	closed	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36	\N	\N	2
5	5	3	1	\N	0.00	\N	\N	\N	2026-04-23 13:23:09.140966	2026-04-23 13:25:30.900779	closed	Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36	\N	\N	3
6	5	3	2	\N	0.00	\N	\N	\N	2026-04-23 23:11:04.331392	\N	open	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 OPR/130.	\N	\N	\N
\.


--
-- Data for Name: pos_terminals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pos_terminals (id, company_id, branch_id, code, name_ar, name_en, machine_code, cash_box_id, is_active, notes, created_at, updated_at) FROM stdin;
2	5	1	T-002	كاشير اختبار TdLW	\N	DEV-89C36Z9P-MOBI5HYG	\N	t	\N	2026-04-23 13:13:06.933502	2026-04-23 13:13:36.272
3	5	1	T-003	اختبار-MERGE	\N	DEV-MDUWIBLP-MOBIHAHX	\N	t	\N	2026-04-23 13:20:01.475168	2026-04-23 13:23:09.142
\.


--
-- Data for Name: purchase_invoice_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_invoice_lines (id, invoice_id, company_id, item_name, item_code, unit, qty, weight, unit_price, discount, vat_rate, line_total, expense_share, final_cost, account_id, warehouse_id, notes, item_id, unit_id, conversion_factor) FROM stdin;
1	1	5	x	\N	pc	10.0000	0.0000	10.0000	0.00	15.00	115.00	0.00	0.00	\N	1	\N	1	\N	1.000000
2	3	5	صنف اختباري	\N	\N	2.0000	0.0000	50.0000	0.00	15.00	115.00	0.00	100.00	\N	1	\N	1	\N	1.000000
\.


--
-- Data for Name: purchase_invoices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_invoices (id, company_id, doc_number, invoice_date, supplier_id, payment_type, currency_code, exchange_rate, lc_id, distribution_method, subtotal, vat_amount, discount_amount, total_expenses_loaded, total_amount, status, notes, created_at, updated_at, cash_box_id, branch_id, inventory_account_id, tax_account_id, discount_account_id, journal_entry_id, price_includes_vat, bank_account_id, supplier_invoice_number) FROM stdin;
1	5	\N	2026-04-21	\N	credit	SAR	1.000000	\N	value	100.00	15.00	0.00	0.00	115.00	posted	\N	2026-04-21 01:15:23.13537	2026-04-21 01:15:23.241	\N	\N	\N	\N	\N	\N	f	\N	\N
3	5	\N	2026-04-21	1	cash	SAR	1.000000	\N	value	100.00	15.00	0.00	0.00	115.00	posted	\N	2026-04-21 08:35:23.735286	2026-04-21 08:35:23.826	1	1	\N	\N	\N	\N	f	\N	\N
\.


--
-- Data for Name: purchase_return_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_return_lines (id, return_id, company_id, item_name, item_code, unit, qty, unit_price, vat_rate, line_total, notes, item_id, unit_id, warehouse_id, conversion_factor, discount) FROM stdin;
\.


--
-- Data for Name: purchase_returns; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_returns (id, company_id, doc_number, return_date, supplier_id, invoice_id, currency_code, exchange_rate, total_amount, vat_amount, status, notes, created_at, updated_at, payment_type, cash_box_id, branch_id, discount_amount, inventory_account_id, tax_account_id, discount_account_id, journal_entry_id, price_includes_vat, bank_account_id, supplier_invoice_number) FROM stdin;
\.


--
-- Data for Name: receipt_vouchers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.receipt_vouchers (id, company_id, branch_id, code, date, payment_type, cash_box_id, bank_account_id, entity_type, entity_id, entity_name, account_id, amount, currency_id, exchange_rate, ref_type, ref_number, description, notes, status, created_at, journal_entry_id) FROM stdin;
1	5	1	RV-0001	2026-04-21	cash	1	\N	customer	1	\N	\N	230.00	\N	1.000000	sales_invoice	6	قبض نقدي للفاتورة رقم 6	\N	posted	2026-04-21 08:35:38.257243	\N
2	5	\N	RV-0002	2026-04-21	cash	\N	\N	customer	\N		\N	123.45	\N	1.000000					draft	2026-04-21 11:46:09.660824	\N
\.


--
-- Data for Name: regions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.regions (id, code, name_ar, name_en, notes, company_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: sales_invoice_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_invoice_lines (id, invoice_id, company_id, item_id, item_name, item_code, unit, unit_id, warehouse_id, qty, unit_price, discount, vat_rate, line_total, notes, conversion_factor) FROM stdin;
1	1	5	1	x	\N	pc	\N	1	2.0000	50.0000	0.00	15.00	115.00	\N	1.000000
2	2	5	1	x	\N	pc	\N	\N	1.0000	100.0000	0.00	15.00	115.00	\N	1.000000
3	3	5	1	x	\N	pc	\N	1	3.0000	100.0000	0.00	15.00	345.00	\N	1.000000
4	4	5	1	x	\N	pc	\N	\N	1.0000	100.0000	0.00	15.00	115.00	\N	1.000000
5	6	5	1	صنف اختباري	\N	\N	\N	1	1.0000	200.0000	0.00	15.00	230.00	\N	1.000000
6	7	5	1	X	\N	\N	\N	1	1.0000	500.0000	0.00	15.00	575.00	\N	1.000000
7	8	5	1	صنف اختباري متكامل	\N	علبة	2	1	1.0000	110.0000	0.00	15.00	0.00	\N	12.000000
8	9	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	\N	1.0000	5000.0000	0.00	15.00	5000.00	\N	1.000000
9	10	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	\N	1.0000	5000.0000	0.00	15.00	5000.00	\N	1.000000
10	11	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	1	1.0000	5000.0000	0.00	15.00	5000.00	\N	1.000000
11	12	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	1	1.0000	5000.0000	0.00	15.00	5000.00	\N	1.000000
14	18	5	2	DiscountTest	DISCOUNTTEST	\N	\N	1	2.0000	100.0000	0.00	15.00	230.00	\N	1.000000
15	19	5	2	DiscountTest	DISCOUNTTEST	\N	\N	1	2.0000	100.0000	0.00	15.00	230.00	\N	1.000000
16	20	5	2	DiscountTest	DISCOUNTTEST	\N	\N	1	2.0000	100.0000	0.00	15.00	230.00	\N	1.000000
17	21	5	2	DiscountTest	DISCOUNTTEST	\N	\N	2	1.0000	0.0000	0.00	15.00	0.00	\N	1.000000
18	22	5	2	DiscountTest	DISCOUNTTEST	\N	\N	2	1.0000	0.0000	0.00	15.00	0.00	\N	1.000000
\.


--
-- Data for Name: sales_invoices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_invoices (id, company_id, doc_number, invoice_date, customer_id, payment_type, currency_code, exchange_rate, subtotal, vat_amount, discount_amount, total_amount, status, notes, created_at, updated_at, branch_id, cash_box_id, cogs_account_id, inventory_account_id, sales_account_id, tax_account_id, discount_account_id, journal_entry_id, zatca_status, zatca_submitted_at, zatca_uuid, zatca_response_code, zatca_error_messages, zatca_warning_messages, zatca_ai_suggestion, price_includes_vat, bank_account_id, pos_session_id, created_by_id) FROM stdin;
1	5	\N	2026-04-21	\N	credit	SAR	1.000000	100.00	15.00	0.00	115.00	posted	\N	2026-04-21 01:15:23.32947	2026-04-21 01:15:23.409	\N	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
2	5	\N	2026-04-21	\N	credit	SAR	1.000000	100.00	15.00	0.00	115.00	draft	محوّل من عرض السعر SQ-2	2026-04-21 01:15:23.8103	2026-04-21 01:15:23.8103	\N	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
3	5	\N	2026-04-21	\N	credit	SAR	1.000000	100.00	15.00	0.00	115.00	posted	\N	2026-04-21 01:16:32.54412	2026-04-21 01:16:32.617	\N	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
4	5	\N	2026-04-21	\N	credit	SAR	1.000000	100.00	15.00	0.00	115.00	draft	محوّل من عرض السعر SQ-3	2026-04-21 01:18:36.891464	2026-04-21 01:18:36.891464	\N	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
7	5	\N	2026-04-21	1	credit	SAR	1.000000	500.00	75.00	0.00	575.00	posted	\N	2026-04-21 08:50:15.072731	2026-04-21 23:47:14.872	1	\N	\N	\N	\N	\N	\N	\N	rejected	2026-04-21 23:47:14.872	\N	400	[{"code":"BR-KSA-CUST-ADDR","message":"العنوان الوطني للعميل (المدينة، الشارع، رقم المبنى، الرمز البريدي) مطلوب للفاتورة الضريبية المعيارية (B2B)."}]	[{"code":"WARN-ITEM-CODE","message":"بعض البنود لا تحتوي على كود الصنف. يُفضّل تحديد الكود لكل بند."},{"code":"WARN-DOC-NUM","message":"رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي."}]	\N	f	\N	\N	\N
8	5	\N	2026-04-21	2	credit	SAR	1.000000	0.00	0.00	0.00	0.00	posted	\N	2026-04-21 09:06:46.890729	2026-04-21 23:47:14.915	\N	\N	\N	\N	\N	\N	\N	\N	rejected	2026-04-21 23:47:14.915	\N	400	[{"code":"BR-KSA-AMOUNT","message":"إجمالي الفاتورة يجب أن يكون أكبر من صفر."}]	[{"code":"WARN-ITEM-CODE","message":"بعض البنود لا تحتوي على كود الصنف. يُفضّل تحديد الكود لكل بند."},{"code":"WARN-DOC-NUM","message":"رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي."}]	\N	f	\N	\N	\N
6	5	\N	2026-04-21	1	cash	SAR	1.000000	200.00	30.00	0.00	230.00	posted	\N	2026-04-21 08:35:38.150103	2026-04-21 23:50:36.649	1	1	\N	\N	\N	\N	\N	\N	approved	2026-04-21 23:50:36.649	ZATCA-5-6-MO9A19BD-2XTC1B	200	\N	[{"code":"WARN-ITEM-CODE","message":"بعض البنود لا تحتوي على كود الصنف. يُفضّل تحديد الكود لكل بند."},{"code":"WARN-DOC-NUM","message":"رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي."}]	\N	f	\N	\N	\N
5	5	\N	2026-04-21	\N	credit	SAR	1.000000	100.00	0.00	0.00	100.00	draft	\N	2026-04-21 08:12:57.787235	2026-04-21 23:50:42.883	2	\N	\N	\N	\N	\N	\N	\N	rejected	2026-04-21 23:50:42.883	\N	400	[{"code":"BR-KSA-DRAFT","message":"لا يمكن إرسال فاتورة في حالة مسودة (draft) إلى الزكاة. يجب ترحيل الفاتورة أولاً."},{"code":"BR-KSA-LINES","message":"الفاتورة لا تحتوي على أي بنود. يجب إضافة بند واحد على الأقل."},{"code":"BR-KSA-VAT-CALC","message":"قيمة ضريبة القيمة المضافة غير متطابقة. المتوقع 15.00 ريال (15% من الصافي 100.00)، ولكن المسجل في الفاتورة 0.00 ريال."}]	[{"code":"WARN-DOC-NUM","message":"رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي."}]	\N	f	\N	\N	\N
9	5	\N	2026-04-22	\N	credit	SAR	1.000000	4347.83	652.17	0.00	5000.00	draft	\N	2026-04-22 07:08:49.604693	2026-04-22 07:08:49.604693	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	t	\N	\N	\N
10	5	\N	2026-04-22	\N	credit	SAR	1.000000	4347.83	652.17	0.00	5000.00	draft	\N	2026-04-22 07:08:55.085536	2026-04-22 07:08:55.085536	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	t	\N	\N	\N
11	5	\N	2026-04-22	\N	credit	SAR	1.000000	4347.83	652.17	0.00	5000.00	draft	\N	2026-04-22 07:09:17.118956	2026-04-22 07:09:17.118956	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	t	\N	\N	\N
12	5	\N	2026-04-22	\N	credit	SAR	1.000000	4347.83	652.17	0.00	5000.00	draft	\N	2026-04-22 07:09:23.433594	2026-04-22 07:09:23.433594	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	t	\N	\N	\N
15	5	\N	2026-04-22	\N	credit	SAR	1.000000	869.57	130.43	50.00	950.00	draft	\N	2026-04-22 07:30:23.768079	2026-04-22 07:30:23.768079	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	t	\N	\N	\N
18	5	\N	2026-04-22	\N	credit	SAR	1.000000	200.00	30.00	0.00	230.00	draft	\N	2026-04-22 10:07:14.476738	2026-04-22 10:07:14.476738	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
19	5	\N	2026-04-22	\N	credit	SAR	1.000000	200.00	30.00	0.00	230.00	draft	\N	2026-04-22 10:07:20.249376	2026-04-22 10:07:20.249376	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
20	5	\N	2026-04-22	\N	credit	SAR	1.000000	200.00	30.00	0.00	230.00	draft	\N	2026-04-22 10:07:20.377319	2026-04-22 10:07:20.377319	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	\N	\N
21	5	\N	2026-04-23	\N	bank	SAR	1.000000	0.00	0.00	0.00	0.00	draft	POS — شبكة	2026-04-23 01:27:45.523712	2026-04-23 01:27:45.523712	1	\N	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	2	3	3
22	5	\N	2026-04-23	\N	cash	SAR	1.000000	0.00	0.00	0.00	0.00	draft	POS — نقداً	2026-04-23 01:28:07.564439	2026-04-23 01:28:07.564439	1	1	\N	\N	\N	\N	\N	\N	pending	\N	\N	\N	\N	\N	\N	f	\N	3	3
\.


--
-- Data for Name: sales_quotation_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_quotation_lines (id, quotation_id, company_id, item_id, item_name, item_code, unit, unit_id, qty, unit_price, discount, vat_rate, line_total, notes) FROM stdin;
1	1	5	\N	Test Item	\N	piece	\N	1.0000	100.0000	0.00	15.00	115.00	\N
2	2	5	1	x	\N	pc	\N	1.0000	100.0000	0.00	15.00	115.00	\N
3	3	5	1	x	\N	pc	\N	1.0000	100.0000	0.00	15.00	115.00	\N
\.


--
-- Data for Name: sales_quotations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_quotations (id, company_id, doc_number, quotation_date, valid_until, customer_id, currency_code, exchange_rate, subtotal, vat_amount, discount_amount, total_amount, status, converted_invoice_id, notes, created_at, updated_at, price_includes_vat) FROM stdin;
1	5	\N	2026-04-21	\N	\N	SAR	1.000000	100.00	15.00	0.00	115.00	draft	\N	\N	2026-04-21 01:14:28.315823	2026-04-21 01:14:28.315823	f
2	5	\N	2026-04-21	\N	\N	SAR	1.000000	100.00	15.00	0.00	115.00	converted	2	\N	2026-04-21 01:15:23.696583	2026-04-21 01:15:23.816	f
3	5	\N	2026-04-21	\N	\N	SAR	1.000000	100.00	15.00	0.00	115.00	converted	4	\N	2026-04-21 01:18:36.597744	2026-04-21 01:18:36.899	f
\.


--
-- Data for Name: sales_return_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_return_lines (id, return_id, company_id, item_id, item_name, item_code, unit, unit_id, warehouse_id, qty, unit_price, vat_rate, line_total, notes, conversion_factor, discount) FROM stdin;
1	1	5	1	x	\N	pc	\N	1	2.0000	50.0000	15.00	115.00	\N	1.000000	0.00
2	2	5	1	x	\N	pc	\N	1	1.0000	50.0000	15.00	57.50	\N	1.000000	0.00
3	3	5	1	x	\N	pc	\N	1	3.0000	100.0000	15.00	345.00	\N	1.000000	0.00
4	5	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	\N	1.0000	1000.0000	15.00	1150.00	\N	1.000000	0.00
5	6	5	1	صنف اختباري متكامل	ITM-E2E-01	قطعة	1	\N	1.0000	1000.0000	15.00	1150.00	\N	1.000000	0.00
6	7	5	\N	Test	\N	\N	\N	\N	1.0000	100.0000	15.00	103.50	\N	1.000000	10.00
7	8	5	\N	X	\N	\N	\N	\N	1.0000	100.0000	15.00	0.00	\N	1.000000	100.00
\.


--
-- Data for Name: sales_returns; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_returns (id, company_id, doc_number, return_date, customer_id, invoice_id, currency_code, exchange_rate, total_amount, vat_amount, status, notes, created_at, updated_at, branch_id, payment_type, cash_box_id, cogs_account_id, inventory_account_id, sales_account_id, tax_account_id, discount_account_id, journal_entry_id, discount_amount, price_includes_vat, bank_account_id) FROM stdin;
1	5	\N	2026-04-21	\N	1	SAR	1.000000	115.00	15.00	draft	\N	2026-04-21 01:15:23.515234	2026-04-21 01:15:23.515234	\N	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
2	5	\N	2026-04-21	\N	1	SAR	1.000000	115.00	15.00	draft	\N	2026-04-21 01:15:35.082386	2026-04-21 01:15:35.082386	\N	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
3	5	\N	2026-04-21	\N	3	SAR	1.000000	115.00	15.00	posted	\N	2026-04-21 01:16:32.706739	2026-04-21 01:16:32.869	\N	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
4	5	\N	2026-04-21	\N	\N	SAR	1.000000	50.00	0.00	draft	\N	2026-04-21 08:12:57.833379	2026-04-21 08:12:57.833379	2	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
5	5	\N	2026-04-22	\N	\N	SAR	1.000000	1050.00	150.00	draft	\N	2026-04-22 07:48:21.595475	2026-04-22 07:48:21.595475	1	credit	\N	\N	\N	\N	\N	\N	\N	100.00	f	\N
6	5	\N	2026-04-22	\N	\N	SAR	1.000000	1050.00	150.00	draft	\N	2026-04-22 07:48:27.20971	2026-04-22 07:48:27.20971	1	credit	\N	\N	\N	\N	\N	\N	\N	100.00	f	\N
7	5	SR-DT1	2026-04-22	\N	\N	SAR	1.000000	103.50	13.50	draft	\N	2026-04-22 08:16:22.997011	2026-04-22 08:16:22.997011	\N	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
8	5	SR-CLAMP1	2026-04-22	\N	\N	SAR	1.000000	0.00	0.00	draft	\N	2026-04-22 08:19:40.235601	2026-04-22 08:19:40.235601	\N	credit	\N	\N	\N	\N	\N	\N	\N	0.00	f	\N
\.


--
-- Data for Name: stock_adjustment_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_adjustment_items (id, adjustment_id, item_id, unit_id, qty, cost_price, notes) FROM stdin;
1	1	2	\N	100.0000	10.0000	\N
2	2	2	\N	-3.0000	10.0000	تلف
\.


--
-- Data for Name: stock_adjustments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_adjustments (id, company_id, adjustment_number, adjustment_date, warehouse_id, reason, status, notes, created_at, updated_at, account_id, inventory_account_id, adjustment_account_id, journal_entry_id) FROM stdin;
1	5	SEED-AI-1	2026-04-22	1	seed	posted	\N	2026-04-22 17:53:18.672302	2026-04-22 17:53:18.851	\N	\N	\N	\N
2	5	ADJ-1776881719024	2026-04-22	1	تلف وخسارة	posted	\N	2026-04-22 18:15:19.025403	2026-04-22 18:15:19.166	\N	9	11	3
\.


--
-- Data for Name: stock_balance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_balance (id, company_id, item_id, warehouse_id, qty, avg_cost, updated_at) FROM stdin;
1	5	1	1	86.0000	16.1538	2026-04-22 07:09:23.471
2	5	2	1	90.0000	10.0000	2026-04-22 18:15:19.15
3	5	2	2	5.0000	10.0000	2026-04-23 01:28:07.593
\.


--
-- Data for Name: stock_count_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_count_items (id, count_id, item_id, system_qty, actual_qty, diff, cost_price, notes) FROM stdin;
\.


--
-- Data for Name: stock_counts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_counts (id, company_id, count_number, count_date, warehouse_id, status, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: stock_ledger; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_ledger (id, company_id, item_id, warehouse_id, tx_date, tx_type, qty, cost_price, total_cost, balance_qty, ref_id, ref_type, notes, created_at) FROM stdin;
1	5	1	1	2026-04-21	purchase	10.0000	0.0000	0.0000	10.0000	1	purchase_invoice	\N	2026-04-21 01:15:23.237049
2	5	1	1	2026-04-21	sale	-2.0000	0.0000	0.0000	8.0000	1	sales_invoice	\N	2026-04-21 01:15:23.406267
3	5	1	1	2026-04-21	sale	-3.0000	10.0000	-30.0000	8.0000	3	sales_invoice	\N	2026-04-21 01:16:32.614109
4	5	1	1	2026-04-21	sales_return	3.0000	10.0000	30.0000	11.0000	3	sales_return	\N	2026-04-21 01:16:32.865919
5	5	1	1	2026-04-21	purchase	2.0000	50.0000	100.0000	13.0000	3	purchase_invoice	\N	2026-04-21 08:35:23.820037
6	5	1	1	2026-04-21	sale	-1.0000	16.1538	-16.1500	12.0000	6	sales_invoice	\N	2026-04-21 08:35:38.248521
7	5	1	1	2026-04-21	sale	-1.0000	16.1538	-16.1500	11.0000	7	sales_invoice	\N	2026-04-21 08:50:15.273246
8	5	1	1	2026-04-21	sale	-12.0000	16.1538	-193.8500	88.0000	8	sales_invoice	\N	2026-04-21 09:07:02.874246
9	5	1	1	2026-04-22	sale	-1.0000	16.1538	-16.1500	87.0000	11	sales_invoice	\N	2026-04-22 07:09:17.171657
10	5	1	1	2026-04-22	sale	-1.0000	16.1538	-16.1500	86.0000	12	sales_invoice	\N	2026-04-22 07:09:23.477346
11	5	2	1	2026-04-22	adjustment	100.0000	10.0000	1000.0000	100.0000	1	adjustment	\N	2026-04-22 17:53:18.848611
12	5	2	1	2026-04-22	transfer_out	-5.0000	10.0000	-50.0000	95.0000	1	transfer	\N	2026-04-22 17:53:19.021879
13	5	2	2	2026-04-22	transfer_in	5.0000	10.0000	50.0000	5.0000	1	transfer	\N	2026-04-22 17:53:19.021879
14	5	2	1	2026-04-22	transfer_out	-2.0000	10.0000	-20.0000	93.0000	2	transfer	\N	2026-04-22 17:56:47.969979
15	5	2	2	2026-04-22	transfer_in	2.0000	10.0000	20.0000	7.0000	2	transfer	\N	2026-04-22 17:56:47.969979
16	5	2	1	2026-04-22	adjustment	-3.0000	10.0000	-30.0000	90.0000	2	adjustment	تلف	2026-04-22 18:15:19.154883
17	5	2	2	2026-04-23	sale	-1.0000	10.0000	-10.0000	6.0000	21	sales_invoice	\N	2026-04-23 01:27:45.57367
18	5	2	2	2026-04-23	sale	-1.0000	10.0000	-10.0000	5.0000	22	sales_invoice	\N	2026-04-23 01:28:07.596381
\.


--
-- Data for Name: stock_transfer_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_transfer_items (id, transfer_id, item_id, unit_id, qty, cost_price) FROM stdin;
1	1	2	\N	5.0000	10.0000
2	2	2	\N	2.0000	10.0000
\.


--
-- Data for Name: stock_transfers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_transfers (id, company_id, transfer_number, transfer_date, from_warehouse_id, to_warehouse_id, status, notes, created_at, updated_at, account_id, from_account_id, to_account_id, journal_entry_id) FROM stdin;
1	5	TRF-1776880398900	2026-04-22	1	2	posted	اختبار قيد AI	2026-04-22 17:53:18.901015	2026-04-22 17:53:19.049	\N	9	10	1
2	5	TRF-1776880607837	2026-04-22	1	2	posted	\N	2026-04-22 17:56:47.838294	2026-04-22 17:56:47.989	\N	9	10	2
\.


--
-- Data for Name: subscriptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subscriptions (id, company_id, plan, max_users, max_invoices, billing_cycle, start_date, end_date, is_active, price, created_at, max_branches, max_warehouses) FROM stdin;
1	3	professional	5	500	monthly	2026-04-19	2026-05-19	t	299	2026-04-19 02:02:09.417246	1	1
2	4	starter	1	50	monthly	2026-04-19	2026-05-19	t	99	2026-04-19 02:02:42.398452	1	1
5	7	professional	5	500	annual	2026-04-19	2027-04-19	t	2990	2026-04-19 02:22:22.578037	1	1
6	8	starter	1	50	monthly	2026-04-19	2026-05-19	t	99	2026-04-19 02:22:22.963403	1	1
3	5	professional	10	1000	yearly	2026-04-22	2027-04-22	t	2990	2026-04-19 02:07:21.379635	3	5
7	1	professional	25	1000	yearly	2026-05-01	2027-05-01	t	2990	2026-04-22 06:34:46.072026	3	5
\.


--
-- Data for Name: supplier_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supplier_groups (id, company_id, code, name_ar, name_en, discount_percent, notes, is_active, created_at) FROM stdin;
\.


--
-- Data for Name: supplier_settlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supplier_settlements (id, company_id, doc_number, settlement_date, supplier_id, payment_method, account_id, amount, currency_code, exchange_rate, status, notes, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: suppliers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.suppliers (id, company_id, name_ar, name_en, vat_number, cr_number, email, phone, city, district, street, building_number, postal_code, country, created_at, account_id, group_id, currency_code, credit_limit, opening_balance, opening_balance_type, is_active, code) FROM stdin;
1	5	مورد اختبار	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-21 08:35:23.685481	\N	\N	SAR	0.00	0.00	credit	t	\N
3	5	مورد اختبار سريع TEST-QA	\N	312222222222223	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 15:59:03.819381	\N	\N	SAR	0.00	0.00	credit	t	\N
4	5	مورد اختبار سريع TEST-QA-RET-3	\N	312222222222225	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 16:01:30.525882	\N	\N	SAR	0.00	0.00	credit	t	\N
6	5	مورد اختبار	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	\N	\N	SAR	0.00	0.00	credit	t	\N
7	5	مورد اختبار سريع TEST-QA	\N	312222222222223	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	\N	\N	SAR	0.00	0.00	credit	t	\N
8	5	مورد اختبار سريع TEST-QA-RET-3	\N	312222222222225	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:54:25.316869	\N	\N	SAR	0.00	0.00	credit	t	\N
9	5	مورد اختبار	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
10	5	مورد اختبار سريع TEST-QA	\N	312222222222223	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
11	5	مورد اختبار سريع TEST-QA-RET-3	\N	312222222222225	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
12	5	مورد اختبار	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
13	5	مورد اختبار سريع TEST-QA	\N	312222222222223	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
14	5	مورد اختبار سريع TEST-QA-RET-3	\N	312222222222225	\N	\N	\N	\N	\N	\N	\N	\N	SA	2026-04-23 21:55:25.701214	\N	\N	SAR	0.00	0.00	credit	t	\N
\.


--
-- Data for Name: support_messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_messages (id, company_id, user_id, sender_name, company_name, subject, body, category, priority, status, admin_reply, admin_reply_at, resolved_at, resolved_by_user_id, created_at, updated_at) FROM stdin;
1	5	3	karm	alazzam	اختبار	هذه رسالة تجريبية	general	high	in_progress	شكراً، سنتابع معك	2026-04-23 11:21:25.609	\N	\N	2026-04-23 11:21:25.556265	2026-04-23 11:21:25.608
2	5	3	karm	alazzam	اختبار من الواجهة	هذا اختبار للنظام الجديد للرسائل	general	high	open	\N	\N	\N	\N	2026-04-23 11:26:32.780537	2026-04-23 11:26:32.780537
3	5	3	karm	alazzam	اختبار من الواجهة	هذا اختبار للنظام الجديد للرسائل	general	normal	in_progress		2026-04-23 11:30:47.155	\N	\N	2026-04-23 11:28:05.610179	2026-04-23 11:30:47.155
\.


--
-- Data for Name: support_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_settings (id, in_app_enabled, webhook_enabled, webhook_url, webhook_secret, telegram_enabled, telegram_bot_token, telegram_chat_id, email_enabled, email_recipients, notify_superadmin_in_app, updated_at, updated_by_user_id) FROM stdin;
1	t	t	https://httpbin.org/post	topsecret	f	\N	\N	f	\N	t	2026-04-23 11:34:46.195	4
\.


--
-- Data for Name: units; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.units (id, company_id, code, name_ar, name_en, conversion_factor, created_at) FROM stdin;
1	5	PCS	قطعة	Piece	1.000000	2026-04-21 09:05:12.655595
2	5	BOX	علبة	Box	1.000000	2026-04-21 09:05:12.703919
3	5	PCS	قطعة	Piece	1.000000	2026-04-23 21:55:25.701214
4	5	BOX	علبة	Box	1.000000	2026-04-23 21:55:25.701214
\.


--
-- Data for Name: user_branches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_branches (user_id, branch_id, created_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, username, email, password_hash, company_id, role, session_token, session_id, last_login_at, is_active, created_at, updated_at, code, name_ar, name_en, permissions) FROM stdin;
2	demo_user	demo@zatca.sa	$2b$12$Nj.q7NyygJuI.VW/iNlcJuMJOuH9ZFAmaqivhpuyJzB9dGe/wpoIG	4	admin	a12819df-75a4-4224-9164-8267473bbe2e-0d0d61b9-2d54-46c2-95b3-5f1202db7d7c	3544e6de-91d4-497b-9cee-025f5d736e41	2026-04-19 02:02:42.726	t	2026-04-19 02:02:42.727072	2026-04-19 02:02:42.727072	\N	\N	\N	\N
6	alnajm_tech	\N	$2b$12$swGLDBb0GYK0k3Rq7KGpluJIGZ8xEuKnhqJ.51Sor.O5JFLxP06uW	7	admin	653d1fa7-db12-4a96-9720-3905074d4a76-f71c7bcb-475a-4199-b0b3-bb94f41ca72c	d3cbead4-5403-44a9-b95e-927772270863	2026-04-19 08:22:26.101	t	2026-04-19 02:22:22.905072	2026-04-19 08:22:26.101	\N	\N	\N	\N
4	superadmin	\N	$2b$10$AyLMdbhnOLwdAsfpzHGYxO.tdmzXv9/OZLOJXbkyARoNb2fo7Ap6S	\N	superadmin	b3af92c2-e183-4234-a30a-68151226a73f-98041441-0a47-419a-818a-3bfd4e07140b	647c8bb4-a8a5-42b4-80ad-6538c91e2e78	2026-04-23 11:34:46.143	t	2026-04-19 02:16:22.036836	2026-04-23 11:34:46.143	\N	\N	\N	\N
7	gulf_biz	\N	$2b$12$hvcMzH2QlZJ5L2uTJD//cOwEmq33i1NptKX3YFKocO1C8ypgubTRC	8	admin	\N	\N	\N	f	2026-04-19 02:22:23.283565	2026-04-19 02:22:23.283565	\N	\N	\N	\N
3	karm	asilkarmazzam@outlook.com	$2a$10$Q3xkQKSmAPbX65Xt4NEPOOtxH0ooEJplKP1RM/HRzKu2fMjoaRsca	5	admin	359ebf84-937f-45a4-bf28-b4d88bd3d336-53799029-f6da-4984-ba74-e293a3c11767	d035855d-7d63-435a-8cd5-c68f0f661e58	2026-04-23 23:10:50.125	t	2026-04-19 02:07:21.724547	2026-04-23 23:10:50.125	\N	\N	\N	\N
1	admin	admin@test.sa	$2a$12$Mu25EVfoRC7wHSnNBfX/COxivu2rF2Yl93fC53ug/7bahuZlexZxe	3	admin	4d364f4b-ae13-471d-9885-185bef3c7865-ed7d591f-62f9-4842-b0e0-6ed194ace41a	c05705a4-a37a-447b-a695-fb8c0739373b	2026-04-23 10:47:15.69	t	2026-04-19 02:02:09.785746	2026-04-23 10:47:15.69	\N	\N	\N	\N
9	karm2	\N	$2b$10$BXAOynl4.NvA2omphRz1SOIUWhsmTZZkseWGGNDpiGCYA3.t111o6	5	admin	b25dab98-1b1c-4d15-9594-e7181db0cf1b-8f3cbed9-3430-4485-a71c-54321b0fe366	8d49de43-db32-4a99-95ae-4cbb0f6208b1	2026-04-23 10:57:36.212	t	2026-04-23 10:57:21.534516	2026-04-23 10:57:36.212	\N	\N	\N	\N
\.


--
-- Data for Name: warehouse_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouse_groups (id, company_id, code, name_ar, name_en, created_at) FROM stdin;
\.


--
-- Data for Name: warehouses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouses (id, company_id, group_id, code, name_ar, name_en, city, region, allow_negative, negative_limit, is_active, created_at, account_id) FROM stdin;
1	5	\N	WH-E2E-01	مخزن الاختبار الشامل				f	\N	t	2026-04-19 17:52:19.289371	1
2	5	\N	WH-AI-02	مخزن الفرع الثاني (اختبار AI)	\N	\N	\N	f	\N	t	2026-04-22 17:52:35.612144	\N
3	5	\N	WH-E2E-01	مخزن الاختبار الشامل				f	\N	t	2026-04-23 21:55:25.701214	\N
4	5	\N	WH-AI-02	مخزن الفرع الثاني (اختبار AI)	\N	\N	\N	f	\N	t	2026-04-23 21:55:25.701214	\N
\.


--
-- Name: accounting_mappings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.accounting_mappings_id_seq', 23, true);


--
-- Name: accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.accounts_id_seq', 53, true);


--
-- Name: auto_backups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.auto_backups_id_seq', 8, true);


--
-- Name: bank_accounts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bank_accounts_id_seq', 9, true);


--
-- Name: branches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.branches_id_seq', 7, true);


--
-- Name: cash_boxes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cash_boxes_id_seq', 7, true);


--
-- Name: cash_transfers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cash_transfers_id_seq', 1, false);


--
-- Name: companies_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.companies_id_seq', 8, true);


--
-- Name: cost_centers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cost_centers_id_seq', 1, false);


--
-- Name: currencies_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.currencies_id_seq', 1, false);


--
-- Name: customer_settlements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.customer_settlements_id_seq', 1, false);


--
-- Name: customers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.customers_id_seq', 17, true);


--
-- Name: employee_attendance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_attendance_id_seq', 1, true);


--
-- Name: employee_contracts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_contracts_id_seq', 1, false);


--
-- Name: employee_leaves_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_leaves_id_seq', 1, false);


--
-- Name: employee_loans_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_loans_id_seq', 1, true);


--
-- Name: employees_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employees_id_seq', 1, true);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.exchange_rates_id_seq', 1, false);


--
-- Name: fiscal_periods_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fiscal_periods_id_seq', 52, true);


--
-- Name: fiscal_years_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fiscal_years_id_seq', 5, true);


--
-- Name: invoice_line_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.invoice_line_items_id_seq', 6, true);


--
-- Name: invoices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.invoices_id_seq', 5, true);


--
-- Name: item_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_groups_id_seq', 1, false);


--
-- Name: item_unit_prices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.item_unit_prices_id_seq', 2, true);


--
-- Name: items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.items_id_seq', 5, true);


--
-- Name: journal_entries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.journal_entries_id_seq', 3, true);


--
-- Name: journal_entry_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.journal_entry_lines_id_seq', 6, true);


--
-- Name: lc_expenses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.lc_expenses_id_seq', 1, false);


--
-- Name: letters_of_credit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.letters_of_credit_id_seq', 1, false);


--
-- Name: notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.notifications_id_seq', 10, true);


--
-- Name: payment_vouchers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_vouchers_id_seq', 2, true);


--
-- Name: payroll_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payroll_lines_id_seq', 1, false);


--
-- Name: payroll_runs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payroll_runs_id_seq', 1, false);


--
-- Name: plan_configs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.plan_configs_id_seq', 3, true);


--
-- Name: pos_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pos_sessions_id_seq', 6, true);


--
-- Name: pos_terminals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pos_terminals_id_seq', 3, true);


--
-- Name: purchase_invoice_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.purchase_invoice_lines_id_seq', 2, true);


--
-- Name: purchase_invoices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.purchase_invoices_id_seq', 5, true);


--
-- Name: purchase_return_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.purchase_return_lines_id_seq', 1, false);


--
-- Name: purchase_returns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.purchase_returns_id_seq', 5, true);


--
-- Name: receipt_vouchers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.receipt_vouchers_id_seq', 2, true);


--
-- Name: regions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.regions_id_seq', 1, false);


--
-- Name: sales_invoice_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_invoice_lines_id_seq', 18, true);


--
-- Name: sales_invoices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_invoices_id_seq', 22, true);


--
-- Name: sales_quotation_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_quotation_lines_id_seq', 3, true);


--
-- Name: sales_quotations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_quotations_id_seq', 3, true);


--
-- Name: sales_return_lines_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_return_lines_id_seq', 7, true);


--
-- Name: sales_returns_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sales_returns_id_seq', 8, true);


--
-- Name: stock_adjustment_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_adjustment_items_id_seq', 2, true);


--
-- Name: stock_adjustments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_adjustments_id_seq', 2, true);


--
-- Name: stock_balance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_balance_id_seq', 3, true);


--
-- Name: stock_count_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_count_items_id_seq', 1, false);


--
-- Name: stock_counts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_counts_id_seq', 1, false);


--
-- Name: stock_ledger_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_ledger_id_seq', 18, true);


--
-- Name: stock_transfer_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_transfer_items_id_seq', 2, true);


--
-- Name: stock_transfers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_transfers_id_seq', 2, true);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subscriptions_id_seq', 7, true);


--
-- Name: supplier_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.supplier_groups_id_seq', 1, false);


--
-- Name: supplier_settlements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.supplier_settlements_id_seq', 1, false);


--
-- Name: suppliers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.suppliers_id_seq', 14, true);


--
-- Name: support_messages_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.support_messages_id_seq', 3, true);


--
-- Name: support_settings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.support_settings_id_seq', 1, false);


--
-- Name: units_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.units_id_seq', 4, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 9, true);


--
-- Name: warehouse_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouse_groups_id_seq', 1, false);


--
-- Name: warehouses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.warehouses_id_seq', 4, true);


--
-- Name: accounting_mappings accounting_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_mappings
    ADD CONSTRAINT accounting_mappings_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: auto_backups auto_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_backups
    ADD CONSTRAINT auto_backups_pkey PRIMARY KEY (id);


--
-- Name: bank_accounts bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: cash_boxes cash_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes
    ADD CONSTRAINT cash_boxes_pkey PRIMARY KEY (id);


--
-- Name: cash_transfers cash_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: cost_centers cost_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centers
    ADD CONSTRAINT cost_centers_pkey PRIMARY KEY (id);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);


--
-- Name: customer_settlements customer_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settlements
    ADD CONSTRAINT customer_settlements_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: employee_attendance employee_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_attendance
    ADD CONSTRAINT employee_attendance_pkey PRIMARY KEY (id);


--
-- Name: employee_contracts employee_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_pkey PRIMARY KEY (id);


--
-- Name: employee_leaves employee_leaves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_leaves
    ADD CONSTRAINT employee_leaves_pkey PRIMARY KEY (id);


--
-- Name: employee_loans employee_loans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_loans
    ADD CONSTRAINT employee_loans_pkey PRIMARY KEY (id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: fiscal_periods fiscal_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_periods
    ADD CONSTRAINT fiscal_periods_pkey PRIMARY KEY (id);


--
-- Name: fiscal_years fiscal_years_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_years
    ADD CONSTRAINT fiscal_years_pkey PRIMARY KEY (id);


--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_unique UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: item_groups item_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_groups
    ADD CONSTRAINT item_groups_pkey PRIMARY KEY (id);


--
-- Name: item_unit_prices item_unit_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_unit_prices
    ADD CONSTRAINT item_unit_prices_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_entry_lines journal_entry_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_pkey PRIMARY KEY (id);


--
-- Name: lc_expenses lc_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_expenses
    ADD CONSTRAINT lc_expenses_pkey PRIMARY KEY (id);


--
-- Name: letters_of_credit letters_of_credit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letters_of_credit
    ADD CONSTRAINT letters_of_credit_pkey PRIMARY KEY (id);


--
-- Name: notification_dismissals notification_dismissals_notification_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dismissals
    ADD CONSTRAINT notification_dismissals_notification_id_user_id_pk PRIMARY KEY (notification_id, user_id);


--
-- Name: notification_reads notification_reads_notification_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_user_id_pk PRIMARY KEY (notification_id, user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: payment_vouchers payment_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_pkey PRIMARY KEY (id);


--
-- Name: payroll_lines payroll_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: plan_configs plan_configs_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_configs
    ADD CONSTRAINT plan_configs_key_unique UNIQUE (key);


--
-- Name: plan_configs plan_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_configs
    ADD CONSTRAINT plan_configs_pkey PRIMARY KEY (id);


--
-- Name: pos_sessions pos_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_sessions
    ADD CONSTRAINT pos_sessions_pkey PRIMARY KEY (id);


--
-- Name: pos_terminals pos_terminals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_terminals
    ADD CONSTRAINT pos_terminals_pkey PRIMARY KEY (id);


--
-- Name: purchase_invoice_lines purchase_invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT purchase_invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_invoices purchase_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_pkey PRIMARY KEY (id);


--
-- Name: purchase_return_lines purchase_return_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT purchase_return_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_returns purchase_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT purchase_returns_pkey PRIMARY KEY (id);


--
-- Name: receipt_vouchers receipt_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_pkey PRIMARY KEY (id);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: sales_invoice_lines sales_invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoice_lines
    ADD CONSTRAINT sales_invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_invoices sales_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_pkey PRIMARY KEY (id);


--
-- Name: sales_quotation_lines sales_quotation_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotation_lines
    ADD CONSTRAINT sales_quotation_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_quotations sales_quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotations
    ADD CONSTRAINT sales_quotations_pkey PRIMARY KEY (id);


--
-- Name: sales_return_lines sales_return_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_return_lines
    ADD CONSTRAINT sales_return_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_returns sales_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_pkey PRIMARY KEY (id);


--
-- Name: stock_adjustment_items stock_adjustment_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustment_items
    ADD CONSTRAINT stock_adjustment_items_pkey PRIMARY KEY (id);


--
-- Name: stock_adjustments stock_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_pkey PRIMARY KEY (id);


--
-- Name: stock_balance stock_balance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balance
    ADD CONSTRAINT stock_balance_pkey PRIMARY KEY (id);


--
-- Name: stock_count_items stock_count_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_items
    ADD CONSTRAINT stock_count_items_pkey PRIMARY KEY (id);


--
-- Name: stock_counts stock_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_pkey PRIMARY KEY (id);


--
-- Name: stock_ledger stock_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_pkey PRIMARY KEY (id);


--
-- Name: stock_transfer_items stock_transfer_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_pkey PRIMARY KEY (id);


--
-- Name: stock_transfers stock_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: supplier_groups supplier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_groups
    ADD CONSTRAINT supplier_groups_pkey PRIMARY KEY (id);


--
-- Name: supplier_settlements supplier_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_settlements
    ADD CONSTRAINT supplier_settlements_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: support_settings support_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_settings
    ADD CONSTRAINT support_settings_pkey PRIMARY KEY (id);


--
-- Name: units units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_pkey PRIMARY KEY (id);


--
-- Name: employee_attendance uq_attendance_emp_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_attendance
    ADD CONSTRAINT uq_attendance_emp_date UNIQUE (employee_id, date);


--
-- Name: employees uq_employees_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT uq_employees_company_code UNIQUE (company_id, code);


--
-- Name: employees uq_employees_company_idnumber; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT uq_employees_company_idnumber UNIQUE (company_id, id_number);


--
-- Name: payroll_runs uq_payroll_company_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT uq_payroll_company_code UNIQUE (company_id, code);


--
-- Name: payroll_runs uq_payroll_company_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT uq_payroll_company_period UNIQUE (company_id, year, month);


--
-- Name: user_branches user_branches_user_id_branch_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_user_id_branch_id_pk PRIMARY KEY (user_id, branch_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: warehouse_groups warehouse_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_groups
    ADD CONSTRAINT warehouse_groups_pkey PRIMARY KEY (id);


--
-- Name: warehouses warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);


--
-- Name: acc_map_company_doc_role_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_map_company_doc_role_uniq ON public.accounting_mappings USING btree (company_id, document_type, role_key);


--
-- Name: cost_centers_company_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cost_centers_company_code_uq ON public.cost_centers USING btree (company_id, code);


--
-- Name: pos_terminals_company_code_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pos_terminals_company_code_uniq ON public.pos_terminals USING btree (company_id, code);


--
-- Name: accounting_mappings accounting_mappings_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_mappings
    ADD CONSTRAINT accounting_mappings_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: accounting_mappings accounting_mappings_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_mappings
    ADD CONSTRAINT accounting_mappings_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: auto_backups auto_backups_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_backups
    ADD CONSTRAINT auto_backups_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: bank_accounts bank_accounts_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: bank_accounts bank_accounts_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: bank_accounts bank_accounts_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: bank_accounts bank_accounts_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_currency_id_currencies_id_fk FOREIGN KEY (currency_id) REFERENCES public.currencies(id);


--
-- Name: branches branches_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: branches branches_region_id_regions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_region_id_regions_id_fk FOREIGN KEY (region_id) REFERENCES public.regions(id);


--
-- Name: cash_boxes cash_boxes_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes
    ADD CONSTRAINT cash_boxes_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: cash_boxes cash_boxes_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes
    ADD CONSTRAINT cash_boxes_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: cash_boxes cash_boxes_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes
    ADD CONSTRAINT cash_boxes_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: cash_boxes cash_boxes_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_boxes
    ADD CONSTRAINT cash_boxes_currency_id_currencies_id_fk FOREIGN KEY (currency_id) REFERENCES public.currencies(id);


--
-- Name: cash_transfers cash_transfers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: cash_transfers cash_transfers_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_currency_id_currencies_id_fk FOREIGN KEY (currency_id) REFERENCES public.currencies(id);


--
-- Name: cash_transfers cash_transfers_from_bank_id_bank_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_from_bank_id_bank_accounts_id_fk FOREIGN KEY (from_bank_id) REFERENCES public.bank_accounts(id);


--
-- Name: cash_transfers cash_transfers_from_cash_box_id_cash_boxes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_from_cash_box_id_cash_boxes_id_fk FOREIGN KEY (from_cash_box_id) REFERENCES public.cash_boxes(id);


--
-- Name: cash_transfers cash_transfers_to_bank_id_bank_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_to_bank_id_bank_accounts_id_fk FOREIGN KEY (to_bank_id) REFERENCES public.bank_accounts(id);


--
-- Name: cash_transfers cash_transfers_to_cash_box_id_cash_boxes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_transfers
    ADD CONSTRAINT cash_transfers_to_cash_box_id_cash_boxes_id_fk FOREIGN KEY (to_cash_box_id) REFERENCES public.cash_boxes(id);


--
-- Name: cost_centers cost_centers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centers
    ADD CONSTRAINT cost_centers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: currencies currencies_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: customer_settlements customer_settlements_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settlements
    ADD CONSTRAINT customer_settlements_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: customer_settlements customer_settlements_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settlements
    ADD CONSTRAINT customer_settlements_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: customer_settlements customer_settlements_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settlements
    ADD CONSTRAINT customer_settlements_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: customers customers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: employee_attendance employee_attendance_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_attendance
    ADD CONSTRAINT employee_attendance_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: employee_attendance employee_attendance_employee_id_employees_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_attendance
    ADD CONSTRAINT employee_attendance_employee_id_employees_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_contracts employee_contracts_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: employee_contracts employee_contracts_employee_id_employees_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_employee_id_employees_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_leaves employee_leaves_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_leaves
    ADD CONSTRAINT employee_leaves_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: employee_leaves employee_leaves_employee_id_employees_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_leaves
    ADD CONSTRAINT employee_leaves_employee_id_employees_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_loans employee_loans_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_loans
    ADD CONSTRAINT employee_loans_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: employee_loans employee_loans_employee_id_employees_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_loans
    ADD CONSTRAINT employee_loans_employee_id_employees_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employees employees_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: employees employees_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: employees employees_payable_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_payable_account_id_accounts_id_fk FOREIGN KEY (payable_account_id) REFERENCES public.accounts(id);


--
-- Name: exchange_rates exchange_rates_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: exchange_rates exchange_rates_from_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_from_currency_id_currencies_id_fk FOREIGN KEY (from_currency_id) REFERENCES public.currencies(id);


--
-- Name: exchange_rates exchange_rates_to_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_to_currency_id_currencies_id_fk FOREIGN KEY (to_currency_id) REFERENCES public.currencies(id);


--
-- Name: fiscal_periods fiscal_periods_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_periods
    ADD CONSTRAINT fiscal_periods_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: fiscal_periods fiscal_periods_fiscal_year_id_fiscal_years_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_periods
    ADD CONSTRAINT fiscal_periods_fiscal_year_id_fiscal_years_id_fk FOREIGN KEY (fiscal_year_id) REFERENCES public.fiscal_years(id) ON DELETE CASCADE;


--
-- Name: fiscal_years fiscal_years_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_years
    ADD CONSTRAINT fiscal_years_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoices invoices_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: item_groups item_groups_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_groups
    ADD CONSTRAINT item_groups_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: item_unit_prices item_unit_prices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_unit_prices
    ADD CONSTRAINT item_unit_prices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: item_unit_prices item_unit_prices_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_unit_prices
    ADD CONSTRAINT item_unit_prices_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: item_unit_prices item_unit_prices_unit_id_units_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_unit_prices
    ADD CONSTRAINT item_unit_prices_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id) ON DELETE CASCADE;


--
-- Name: items items_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: items items_group_id_item_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_group_id_item_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.item_groups(id);


--
-- Name: items items_unit_id_units_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: journal_entries journal_entries_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: journal_entries journal_entries_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: journal_entry_lines journal_entry_lines_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: journal_entry_lines journal_entry_lines_entry_id_journal_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entry_lines
    ADD CONSTRAINT journal_entry_lines_entry_id_journal_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;


--
-- Name: lc_expenses lc_expenses_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_expenses
    ADD CONSTRAINT lc_expenses_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: lc_expenses lc_expenses_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_expenses
    ADD CONSTRAINT lc_expenses_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: lc_expenses lc_expenses_lc_id_letters_of_credit_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_expenses
    ADD CONSTRAINT lc_expenses_lc_id_letters_of_credit_id_fk FOREIGN KEY (lc_id) REFERENCES public.letters_of_credit(id) ON DELETE CASCADE;


--
-- Name: letters_of_credit letters_of_credit_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letters_of_credit
    ADD CONSTRAINT letters_of_credit_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: letters_of_credit letters_of_credit_supplier_id_suppliers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letters_of_credit
    ADD CONSTRAINT letters_of_credit_supplier_id_suppliers_id_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: notification_dismissals notification_dismissals_notification_id_notifications_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dismissals
    ADD CONSTRAINT notification_dismissals_notification_id_notifications_id_fk FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_dismissals notification_dismissals_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dismissals
    ADD CONSTRAINT notification_dismissals_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_notification_id_notifications_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_notifications_id_fk FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_vouchers payment_vouchers_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: payment_vouchers payment_vouchers_bank_account_id_bank_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_bank_account_id_bank_accounts_id_fk FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);


--
-- Name: payment_vouchers payment_vouchers_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: payment_vouchers payment_vouchers_cash_box_id_cash_boxes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_cash_box_id_cash_boxes_id_fk FOREIGN KEY (cash_box_id) REFERENCES public.cash_boxes(id);


--
-- Name: payment_vouchers payment_vouchers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payment_vouchers payment_vouchers_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_vouchers
    ADD CONSTRAINT payment_vouchers_currency_id_currencies_id_fk FOREIGN KEY (currency_id) REFERENCES public.currencies(id);


--
-- Name: payroll_lines payroll_lines_employee_id_employees_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_employee_id_employees_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: payroll_lines payroll_lines_payroll_run_id_payroll_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_payroll_run_id_payroll_runs_id_fk FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE;


--
-- Name: payroll_runs payroll_runs_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: payroll_runs payroll_runs_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: pos_sessions pos_sessions_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_sessions
    ADD CONSTRAINT pos_sessions_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: pos_sessions pos_sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_sessions
    ADD CONSTRAINT pos_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pos_terminals pos_terminals_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_terminals
    ADD CONSTRAINT pos_terminals_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: pos_terminals pos_terminals_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_terminals
    ADD CONSTRAINT pos_terminals_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: purchase_invoice_lines purchase_invoice_lines_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT purchase_invoice_lines_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: purchase_invoice_lines purchase_invoice_lines_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT purchase_invoice_lines_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: purchase_invoice_lines purchase_invoice_lines_invoice_id_purchase_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT purchase_invoice_lines_invoice_id_purchase_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.purchase_invoices(id) ON DELETE CASCADE;


--
-- Name: purchase_invoices purchase_invoices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: purchase_invoices purchase_invoices_lc_id_letters_of_credit_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_lc_id_letters_of_credit_id_fk FOREIGN KEY (lc_id) REFERENCES public.letters_of_credit(id);


--
-- Name: purchase_invoices purchase_invoices_supplier_id_suppliers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_supplier_id_suppliers_id_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: purchase_return_lines purchase_return_lines_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT purchase_return_lines_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: purchase_return_lines purchase_return_lines_return_id_purchase_returns_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT purchase_return_lines_return_id_purchase_returns_id_fk FOREIGN KEY (return_id) REFERENCES public.purchase_returns(id) ON DELETE CASCADE;


--
-- Name: purchase_returns purchase_returns_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT purchase_returns_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: purchase_returns purchase_returns_invoice_id_purchase_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT purchase_returns_invoice_id_purchase_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.purchase_invoices(id);


--
-- Name: purchase_returns purchase_returns_supplier_id_suppliers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT purchase_returns_supplier_id_suppliers_id_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: receipt_vouchers receipt_vouchers_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: receipt_vouchers receipt_vouchers_bank_account_id_bank_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_bank_account_id_bank_accounts_id_fk FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);


--
-- Name: receipt_vouchers receipt_vouchers_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: receipt_vouchers receipt_vouchers_cash_box_id_cash_boxes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_cash_box_id_cash_boxes_id_fk FOREIGN KEY (cash_box_id) REFERENCES public.cash_boxes(id);


--
-- Name: receipt_vouchers receipt_vouchers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: receipt_vouchers receipt_vouchers_currency_id_currencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_vouchers
    ADD CONSTRAINT receipt_vouchers_currency_id_currencies_id_fk FOREIGN KEY (currency_id) REFERENCES public.currencies(id);


--
-- Name: regions regions_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: sales_invoice_lines sales_invoice_lines_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoice_lines
    ADD CONSTRAINT sales_invoice_lines_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_invoice_lines sales_invoice_lines_invoice_id_sales_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoice_lines
    ADD CONSTRAINT sales_invoice_lines_invoice_id_sales_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.sales_invoices(id) ON DELETE CASCADE;


--
-- Name: sales_invoices sales_invoices_cogs_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_cogs_account_id_accounts_id_fk FOREIGN KEY (cogs_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_invoices sales_invoices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_invoices sales_invoices_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: sales_invoices sales_invoices_discount_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_discount_account_id_accounts_id_fk FOREIGN KEY (discount_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_invoices sales_invoices_inventory_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_inventory_account_id_accounts_id_fk FOREIGN KEY (inventory_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_invoices sales_invoices_sales_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_sales_account_id_accounts_id_fk FOREIGN KEY (sales_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_invoices sales_invoices_tax_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_invoices
    ADD CONSTRAINT sales_invoices_tax_account_id_accounts_id_fk FOREIGN KEY (tax_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_quotation_lines sales_quotation_lines_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotation_lines
    ADD CONSTRAINT sales_quotation_lines_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_quotation_lines sales_quotation_lines_quotation_id_sales_quotations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotation_lines
    ADD CONSTRAINT sales_quotation_lines_quotation_id_sales_quotations_id_fk FOREIGN KEY (quotation_id) REFERENCES public.sales_quotations(id) ON DELETE CASCADE;


--
-- Name: sales_quotations sales_quotations_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotations
    ADD CONSTRAINT sales_quotations_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_quotations sales_quotations_converted_invoice_id_sales_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotations
    ADD CONSTRAINT sales_quotations_converted_invoice_id_sales_invoices_id_fk FOREIGN KEY (converted_invoice_id) REFERENCES public.sales_invoices(id);


--
-- Name: sales_quotations sales_quotations_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_quotations
    ADD CONSTRAINT sales_quotations_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: sales_return_lines sales_return_lines_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_return_lines
    ADD CONSTRAINT sales_return_lines_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_return_lines sales_return_lines_return_id_sales_returns_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_return_lines
    ADD CONSTRAINT sales_return_lines_return_id_sales_returns_id_fk FOREIGN KEY (return_id) REFERENCES public.sales_returns(id) ON DELETE CASCADE;


--
-- Name: sales_returns sales_returns_cogs_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_cogs_account_id_accounts_id_fk FOREIGN KEY (cogs_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_returns sales_returns_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sales_returns sales_returns_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_customer_id_customers_id_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: sales_returns sales_returns_discount_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_discount_account_id_accounts_id_fk FOREIGN KEY (discount_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_returns sales_returns_inventory_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_inventory_account_id_accounts_id_fk FOREIGN KEY (inventory_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_returns sales_returns_invoice_id_sales_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_invoice_id_sales_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.sales_invoices(id);


--
-- Name: sales_returns sales_returns_sales_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_sales_account_id_accounts_id_fk FOREIGN KEY (sales_account_id) REFERENCES public.accounts(id);


--
-- Name: sales_returns sales_returns_tax_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_returns
    ADD CONSTRAINT sales_returns_tax_account_id_accounts_id_fk FOREIGN KEY (tax_account_id) REFERENCES public.accounts(id);


--
-- Name: stock_adjustment_items stock_adjustment_items_adjustment_id_stock_adjustments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustment_items
    ADD CONSTRAINT stock_adjustment_items_adjustment_id_stock_adjustments_id_fk FOREIGN KEY (adjustment_id) REFERENCES public.stock_adjustments(id) ON DELETE CASCADE;


--
-- Name: stock_adjustment_items stock_adjustment_items_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustment_items
    ADD CONSTRAINT stock_adjustment_items_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_adjustment_items stock_adjustment_items_unit_id_units_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustment_items
    ADD CONSTRAINT stock_adjustment_items_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: stock_adjustments stock_adjustments_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: stock_adjustments stock_adjustments_adjustment_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_adjustment_account_id_accounts_id_fk FOREIGN KEY (adjustment_account_id) REFERENCES public.accounts(id);


--
-- Name: stock_adjustments stock_adjustments_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_adjustments stock_adjustments_inventory_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_inventory_account_id_accounts_id_fk FOREIGN KEY (inventory_account_id) REFERENCES public.accounts(id);


--
-- Name: stock_adjustments stock_adjustments_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_warehouse_id_warehouses_id_fk FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_balance stock_balance_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balance
    ADD CONSTRAINT stock_balance_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_balance stock_balance_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balance
    ADD CONSTRAINT stock_balance_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: stock_balance stock_balance_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balance
    ADD CONSTRAINT stock_balance_warehouse_id_warehouses_id_fk FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON DELETE CASCADE;


--
-- Name: stock_count_items stock_count_items_count_id_stock_counts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_items
    ADD CONSTRAINT stock_count_items_count_id_stock_counts_id_fk FOREIGN KEY (count_id) REFERENCES public.stock_counts(id) ON DELETE CASCADE;


--
-- Name: stock_count_items stock_count_items_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_items
    ADD CONSTRAINT stock_count_items_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_counts stock_counts_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_counts stock_counts_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_warehouse_id_warehouses_id_fk FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_ledger stock_ledger_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_ledger stock_ledger_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_ledger stock_ledger_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_warehouse_id_warehouses_id_fk FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_transfer_items stock_transfer_items_item_id_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: stock_transfer_items stock_transfer_items_transfer_id_stock_transfers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_transfer_id_stock_transfers_id_fk FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id) ON DELETE CASCADE;


--
-- Name: stock_transfer_items stock_transfer_items_unit_id_units_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_unit_id_units_id_fk FOREIGN KEY (unit_id) REFERENCES public.units(id);


--
-- Name: stock_transfers stock_transfers_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: stock_transfers stock_transfers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: stock_transfers stock_transfers_from_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_from_account_id_accounts_id_fk FOREIGN KEY (from_account_id) REFERENCES public.accounts(id);


--
-- Name: stock_transfers stock_transfers_from_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_from_warehouse_id_warehouses_id_fk FOREIGN KEY (from_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: stock_transfers stock_transfers_to_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_to_account_id_accounts_id_fk FOREIGN KEY (to_account_id) REFERENCES public.accounts(id);


--
-- Name: stock_transfers stock_transfers_to_warehouse_id_warehouses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_to_warehouse_id_warehouses_id_fk FOREIGN KEY (to_warehouse_id) REFERENCES public.warehouses(id);


--
-- Name: subscriptions subscriptions_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: supplier_groups supplier_groups_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_groups
    ADD CONSTRAINT supplier_groups_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: supplier_settlements supplier_settlements_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_settlements
    ADD CONSTRAINT supplier_settlements_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: supplier_settlements supplier_settlements_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_settlements
    ADD CONSTRAINT supplier_settlements_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: supplier_settlements supplier_settlements_supplier_id_suppliers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_settlements
    ADD CONSTRAINT supplier_settlements_supplier_id_suppliers_id_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: suppliers suppliers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: support_messages support_messages_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: support_messages support_messages_resolved_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_resolved_by_user_id_users_id_fk FOREIGN KEY (resolved_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_messages support_messages_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_settings support_settings_updated_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_settings
    ADD CONSTRAINT support_settings_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: units units_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.units
    ADD CONSTRAINT units_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_branches user_branches_branch_id_branches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_branch_id_branches_id_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: user_branches user_branches_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: warehouse_groups warehouse_groups_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_groups
    ADD CONSTRAINT warehouse_groups_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: warehouses warehouses_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: warehouses warehouses_group_id_warehouse_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_group_id_warehouse_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.warehouse_groups(id);


--
-- PostgreSQL database dump complete
--

\unrestrict 8x0tiDPmUgend7nHhl7R0UKqqcjjguVb3Rhs1vjdebPbAKKVrwmxSYXgWD3mEnI

