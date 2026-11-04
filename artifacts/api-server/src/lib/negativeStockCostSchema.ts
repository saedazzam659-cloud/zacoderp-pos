import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Additive storage for purchase-to-sale cost coverage allocations.
 * Existing sale/purchase ledger rows remain immutable; reversals are recorded
 * by changing an allocation's status and retaining its audit data.
 */
export async function ensureNegativeStockCostSchema(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS negative_stock_cost_settlements (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sales_invoice_id INTEGER NOT NULL,
      sales_line_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      purchase_line_id INTEGER,
      item_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      original_quantity NUMERIC(18,4) NOT NULL,
      quantity NUMERIC(18,4) NOT NULL,
      provisional_unit_cost NUMERIC(14,4) NOT NULL,
      actual_unit_cost NUMERIC(14,4) NOT NULL,
      adjustment_amount NUMERIC(18,2) NOT NULL,
      cogs_account_id INTEGER,
      inventory_account_id INTEGER,
      cost_center TEXT,
      journal_entry_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversed_at TIMESTAMP
    )
  `));
  await db.execute(sql.raw(`
    ALTER TABLE negative_stock_cost_settlements
      ALTER COLUMN purchase_invoice_id DROP NOT NULL,
      ALTER COLUMN purchase_line_id DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS original_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cogs_account_id INTEGER,
      ADD COLUMN IF NOT EXISTS inventory_account_id INTEGER,
      ADD COLUMN IF NOT EXISTS cost_center TEXT
  `));
  await db.execute(sql.raw(`
    UPDATE negative_stock_cost_settlements
    SET original_quantity = quantity
    WHERE original_quantity = 0 AND purchase_invoice_id IS NULL
  `));
  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS negative_stock_cost_active_purchase_sale_uq
      ON negative_stock_cost_settlements(company_id, purchase_line_id, sales_line_id)
      WHERE status = 'active'
  `));
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS negative_stock_cost_sales_line_idx
      ON negative_stock_cost_settlements(company_id, sales_line_id, status)
  `));
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS negative_stock_cost_purchase_idx
      ON negative_stock_cost_settlements(company_id, purchase_invoice_id, status)
  `));
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS negative_stock_cost_pending_idx
      ON negative_stock_cost_settlements(company_id, item_id, warehouse_id, id)
      WHERE status = 'pending'
  `));
}
