# ERD — Entity Relationships Overview

**69 tables** across 12 business domains. Every business table carries
`companyId` (FK → `companies.id`) for multi-tenant isolation.

## Domain map

```
┌──────────────────────────────────────────────────────────────────────┐
│                           companies (tenant root)                    │
│   ├── branches                                                       │
│   ├── users ────┬── user_branches                                    │
│   └── subscriptions → plan_configs                                   │
└──────────────────────────────────────────────────────────────────────┘
                               │
  ┌──── Accounting ────────────┼──── Inventory ──────────────────┐
  │ accounts (chart of COA)    │ items → item_groups, units      │
  │ accounting_mappings        │ item_unit_prices                │
  │ cost_centers               │ warehouses → warehouse_groups   │
  │ journal_entries            │ stock_balance, stock_ledger     │
  │ └── journal_entry_lines    │ stock_adjustments → items       │
  │ fiscal_years → periods     │ stock_counts → count_items      │
  │ currencies, exchange_rates │ stock_transfers → transfer_items│
  └────────────────────────────┴─────────────────────────────────┘

  ┌──── Sales ──────────────────────┬──── Purchasing ─────────────┐
  │ customers                       │ suppliers → supplier_groups │
  │ sales_quotations → lines        │ purchase_invoices → lines   │
  │ sales_invoices → lines          │ purchase_returns  → lines   │
  │ sales_returns    → lines        │ letters_of_credit           │
  │ customer_settlements            │ └── lc_expenses             │
  │ receipt_vouchers                │ supplier_settlements        │
  │                                 │ payment_vouchers            │
  └─────────────────────────────────┴─────────────────────────────┘

  ┌──── POS ────────────────────┬──── HR ──────────────────────────┐
  │ pos_terminals → branches    │ employees → employee_contracts   │
  │ pos_sessions  → terminals   │ employee_attendance, _leaves     │
  │                             │ employee_loans                   │
  │                             │ payroll_runs → payroll_lines     │
  └─────────────────────────────┴──────────────────────────────────┘

  ┌──── Cash ──────────────────┬──── Platform / meta ──────────────┐
  │ cash_boxes                  │ notifications → reads / dismiss  │
  │ bank_accounts               │ support_messages, support_settings│
  │ cash_transfers              │ auto_backups                      │
  │                             │ invoices, invoice_line_items      │
  │                             │ (platform billing)                │
  └─────────────────────────────┴──────────────────────────────────┘
```

## Key relationships (FK)

### Sales chain

```
customers (1) ─── (N) sales_quotations ─── (N) sales_quotation_lines
customers (1) ─── (N) sales_invoices   ─── (N) sales_invoice_lines
sales_invoices (1) ─── (N) sales_returns ─── (N) sales_return_lines
sales_invoices / returns ──► journal_entries (posting)
sales_invoice_lines      ──► items, warehouses, units
```

### Purchasing chain

```
suppliers (1) ─── (N) purchase_invoices ─── (N) purchase_invoice_lines
purchase_invoices (1) ── (N) purchase_returns ─── (N) purchase_return_lines
letters_of_credit (1) ── (N) lc_expenses ─── (ref) purchase_invoices
```

### Accounting

```
accounts is a self-referencing tree (parentId → accounts.id)
journal_entries (1) ─── (N) journal_entry_lines ─── (FK) accounts, cost_centers
accounting_mappings unique key: (companyId, documentType, roleKey) → accountId
```

### Inventory movement

```
Every posting of a sales/purchase/adjustment/transfer doc inserts rows into
`stock_ledger` (immutable, append-only) and updates `stock_balance`
(per item × warehouse aggregates).
```

### POS

```
pos_terminals (branch-scoped)
  └── pos_sessions (cashier login → start/end cash, linked invoices)
        └── sales_invoices (posSessionId FK)
```

### Multi-tenant auth

```
users.companyId   →  companies.id   (null for platform super-admins)
users.role        ∈ {superadmin, admin, accountant, cashier, viewer}
user_branches       →  restricts a user to specific branches
```

## Generating a visual ERD

The included `database_schema.sql` is compatible with:

* **dbdiagram.io** — paste the file (supports plain PostgreSQL DDL)
* **DBeaver** — open the DB → Database → ER Diagram
* **pgAdmin** → right-click schema → ERD for Schema

For a programmatic diagram:

```bash
# Install SchemaSpy or similar and point it at DATABASE_URL:
schemaspy -t pgsql -host localhost -db zacoderp -u postgres -p ****  -o ./erd-html
```
