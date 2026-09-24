// Run only through scripts/run-isolated-contracting-lifecycle.sh (disposable PG).
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ensureContractingAccountingTables } from "../src/lib/contracting-accounting-storage.ts";
import {
  parseContractingAllocation, resolveContractingLine, postVoucherSettlements,
  assertVoucherCanUnpost,
} from "../src/lib/contracting-voucher-service.ts";
import receiptRouter from "../src/routes/receipt-vouchers.ts";
import paymentRouter from "../src/routes/payment-vouchers.ts";

const armed = process.env.CONTRACTING_ISOLATED_LIFECYCLE === "1";
const result = (r: any): any[] => Array.isArray(r) ? r : r.rows;
const req = { authUser: { id: null, role: "admin", viewAllBranches: true, branchIds: [] } };

test("contracting voucher allocations share the voucher JE, cap direct balances, reject foreign tenant and reverse safely",
  { skip: !armed }, async () => {
    assert.match(process.env.DATABASE_URL ?? "", /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?sslmode=disable$/);
    await ensureContractingAccountingTables();
    const tag = randomUUID().replaceAll("-", "");
    const add = async (statement: string, args: unknown[] = []) => {
      const r = await pool.query(statement, args);
      return r.rows[0]?.id as number;
    };
    const company = await add(`INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
      VALUES ($1, $1, $1, 'Riyadh', 'Test', '1', '12345') RETURNING id`, [tag]);
    const other = await add(`INSERT INTO companies(name_ar, vat_number, cr_number, city, street, building_number, postal_code)
      VALUES ($1, $1, $1, 'Riyadh', 'Test', '1', '12345') RETURNING id`, [`other${tag}`]);
    try {
      const customer = await add(`INSERT INTO customers(company_id, name_ar) VALUES ($1, $2) RETURNING id`, [company, tag]);
      const supplier = await add(`INSERT INTO suppliers(company_id, name_ar) VALUES ($1, $2) RETURNING id`, [company, tag]);
      const contractor = await add(`INSERT INTO contracting_contractors(company_id, name, supplier_id)
        VALUES ($1, $2, $3) RETURNING id`, [company, tag, supplier]);
      const project = await add(`INSERT INTO contracting_projects(company_id, code, name_ar, customer_id)
        VALUES ($1, $2, $2, $3) RETURNING id`, [company, tag, customer]);
      const owner = await add(`INSERT INTO contracting_owner_contracts
        (company_id, project_id, customer_id, contract_number, contract_date, status, value, advance_payment)
        VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active', 1000, 100) RETURNING id`, [company, project, customer, tag]);
      const sub = await add(`INSERT INTO contracting_sub_contracts
        (company_id, project_id, contractor_id, contract_number, contract_date, status, value, advance_payment)
        VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active', 1000, 100) RETURNING id`, [company, project, contractor, tag]);
      const cashAcct = await add(`INSERT INTO accounts(company_id, code, name_ar, account_type)
        VALUES ($1, $2, 'Cash', 'asset') RETURNING id`, [company, `cash${tag}`]);
      const cashBox = await add(`INSERT INTO cash_boxes(company_id, code, name_ar, account_id)
        VALUES ($1, $2, 'Cash', $3) RETURNING id`, [company, tag, cashAcct]);
      const roles = [
        ["contracting_advance_receipt", "advance_liability", "liability"],
        ["contracting_outgoing_bill", "receivable", "asset"],
        ["contracting_advance_payment", "advance_asset", "asset"],
        ["contracting_incoming_bill", "payable", "liability"],
      ];
      const accounts: number[] = [];
      for (const [mapping, role, type] of roles) {
        const acct = await add(`INSERT INTO accounts(company_id, code, name_ar, account_type)
          VALUES ($1, $2, $2, $3) RETURNING id`, [company, `${tag}${role}`, type]);
        accounts.push(acct);
        await pool.query(`INSERT INTO accounting_mappings(company_id, document_type, role_key, account_id)
          VALUES ($1, $2, $3, $4)`, [company, mapping, role, acct]);
      }
      const approved = [];
      for (const [direction, contract] of [["outgoing", owner], ["incoming", sub]] as const) {
        const je = await add(`INSERT INTO journal_entries(company_id, entry_date, entry_type, status)
          VALUES ($1, '2026-01-01', 'contracting_bill', 'posted') RETURNING id`, [company]);
        approved.push(await add(`INSERT INTO contracting_progress_bills
          (company_id, project_id, direction, owner_contract_id, subcontractor_contract_id, contractor_id,
           bill_number, bill_date, status, journal_entry_id, net_amount)
          VALUES ($1, $2, $3, $4, $5, $8, $6, '2026-01-01', 'approved', $7, 100)
          RETURNING id`, [company, project, direction,
          direction === "outgoing" ? owner : null, direction === "incoming" ? sub : null, `${tag}${direction}`, je,
          direction === "incoming" ? contractor : null]));
      }
      const cases = [
        ["owner_advance", "receipt", customer, owner, null, accounts[0]],
        ["owner_bill", "receipt", customer, owner, approved[0], accounts[1]],
        ["subcontract_advance", "payment", supplier, sub, null, accounts[2]],
        ["subcontract_bill", "payment", supplier, sub, approved[1], accounts[3]],
      ] as const;
      for (const [kind, direction, party, contract, billId, expectedAccount] of cases) {
        const allocation = parseContractingAllocation({ kind, projectId: project, contractId: contract, billId }, direction)!;
        assert.equal(await resolveContractingLine(db, company, direction, party, allocation, req), expectedAccount);
        await assert.rejects(resolveContractingLine(db, other, direction, party, allocation, req), /مشروع/);
        await assert.rejects(resolveContractingLine(db, company, direction, party + 123456, allocation, req), /العقد/);
        const voucher = await add(`INSERT INTO ${direction === "receipt" ? "receipt_vouchers" : "payment_vouchers"}
          (company_id, code, date, entity_type, entity_id, cash_box_id, amount, status)
          VALUES ($1, $2, '2026-01-01', $3, $4, $5, 20, 'posted') RETURNING id`,
          [company, `${tag}${kind}`, direction === "receipt" ? "customer" : "supplier", party, cashBox]);
        const je = await add(`INSERT INTO journal_entries(company_id, entry_date, entry_type, status)
          VALUES ($1, '2026-01-01', $2, 'posted') RETURNING id`, [company, direction]);
        const line = await add(`INSERT INTO ${direction === "receipt" ? "receipt_voucher_lines" : "payment_voucher_lines"}
          (voucher_id, account_id, amount, contracting_kind, contracting_project_id, contracting_contract_id, contracting_bill_id)
          VALUES ($1, $2, 20, $3, $4, $5, $6) RETURNING id`,
          [voucher, expectedAccount, kind, project, contract, billId]);
        const source = { id: line, accountId: expectedAccount, amount: "20.00",
          contractingKind: kind, contractingProjectId: project, contractingContractId: contract, contractingBillId: billId };
        const v = { id: voucher, date: "2026-01-01", entityId: party, paymentType: "cash", cashBoxId: cashBox, exchangeRate: "1" };
        await db.transaction((tx) => postVoucherSettlements(tx, company, direction, v, [source], je, req));
        const match = result(await db.execute(sql`SELECT * FROM contracting_accounting_settlements
          WHERE source_voucher_line_id = ${line} AND source_voucher_type = ${direction} AND status = 'posted'`));
        assert.equal(match.length, 1);
        assert.equal(match[0].journal_entry_id, je, "one voucher JE, no second settlement JE");
        await db.transaction((tx) => postVoucherSettlements(tx, company, direction, v, [source], je, req));
        assert.equal(result(await db.execute(sql`SELECT count(*)::int AS count FROM contracting_accounting_settlements
          WHERE source_voucher_line_id = ${line} AND source_voucher_type = ${direction}`))[0].count, 1, "same line replays without a second settlement");
        const links = await db.transaction((tx) => assertVoucherCanUnpost(tx, company, direction, voucher));
        assert.equal(links.length, 1);
        if (billId) {
          const [paid] = result(await db.execute(sql`SELECT paid_amount FROM contracting_progress_bills WHERE id = ${billId}`));
          assert.equal(Number(paid.paid_amount), 20);
        }
      }
      // Ordinary voucher lines remain unlinked and do not manufacture settlements.
      assert.equal(result(await db.execute(sql`SELECT count(*)::int AS count FROM contracting_accounting_settlements
        WHERE company_id = ${company} AND source_voucher_line_id IS NOT NULL`))[0].count, 4);
      for (const direction of ["receipt", "payment"] as const) {
        const [advance] = result(await db.execute(sql`SELECT id, source_voucher_id FROM contracting_accounting_settlements
          WHERE company_id = ${company} AND source_voucher_type = ${direction}
            AND kind = ${direction === "receipt" ? "advance_receipt" : "advance_payment"}`));
        await db.execute(sql`UPDATE contracting_accounting_settlements SET applied_amount = 5
          WHERE id = ${advance.id} AND company_id = ${company}`);
        await assert.rejects(db.transaction((tx) => assertVoucherCanUnpost(tx, company, direction,
          Number(advance.source_voucher_id))), /سلفة مطبقة/);
        await db.execute(sql`UPDATE contracting_accounting_settlements SET applied_amount = 0
          WHERE id = ${advance.id} AND company_id = ${company}`);
      }
      const app = express();
      app.use(express.json());
      const authId = await add(`INSERT INTO users(company_id, username, password_hash, role)
        VALUES ($1, $2, 'isolated', 'admin') RETURNING id`, [company, tag]);
      app.use((request, _response, next) => {
        (request as any).authUser = { ...req.authUser, id: authId, username: tag,
          role: "admin", companyId: company, companyMenuPermissions: null };
        next();
      });
      app.use("/receipt-vouchers", receiptRouter);
      app.use("/payment-vouchers", paymentRouter);
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const send = async (path: string, method: string, body?: any) => {
          const response = await fetch(base + path, {
            method, headers: { "content-type": "application/json" },
            body: body == null ? undefined : JSON.stringify(body),
          });
          return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
        };
        const salesInvoice = await add(`INSERT INTO sales_invoices(company_id, invoice_date, customer_id, total_amount)
          VALUES ($1, '2026-01-01', $2, 100) RETURNING id`, [company, customer]);
        const purchaseInvoice = await add(`INSERT INTO purchase_invoices(company_id, invoice_date, supplier_id, total_amount)
          VALUES ($1, '2026-01-01', $2, 100) RETURNING id`, [company, supplier]);
        for (const [direction, party, contract, billId, invoiceKey, invoiceId] of [
          ["receipt", customer, owner, approved[0], "salesInvoiceId", salesInvoice],
          ["payment", supplier, sub, approved[1], "purchaseInvoiceId", purchaseInvoice],
        ] as const) {
          const endpoint = `/${direction}-vouchers`;
          const kind = direction === "receipt" ? "owner_bill" : "subcontract_bill";
          const lines = [
            { amount: "10.00", contractingAllocation: { kind, projectId: project, contractId: contract, billId } },
            { accountId: cashAcct, amount: "5.00", [invoiceKey]: invoiceId },
          ];
          const blocked = await send(endpoint, "POST", {
            companyId: company, code: `${tag}blocked${direction}`, date: "2026-01-01",
            entityId: party, cashBoxId: cashBox, [invoiceKey]: invoiceId, lines,
          });
          assert.equal(blocked.status, 400, "mixed voucher cannot settle header invoice with contracting lines");
          const created = await send(endpoint, "POST", {
            companyId: company, code: `${tag}mixed${direction}`, date: "2026-01-01",
            entityId: party, cashBoxId: cashBox, lines,
          });
          assert.equal(created.status, 201, JSON.stringify(created.body));
          const read = await send(`${endpoint}/${created.body.id}?companyId=${company}`, "GET");
          assert.equal(read.body.lines.length, 2);
          assert.equal(read.body.lines[0].contractingAllocation.billId, billId);
          assert.equal(read.body.lines[1][invoiceKey], invoiceId, "ordinary invoice line survives");
          const posted = await send(`${endpoint}/${created.body.id}/post?companyId=${company}`, "POST");
          assert.equal(posted.status, 200, JSON.stringify(posted.body));
          const replay = await send(`${endpoint}/${created.body.id}/post?companyId=${company}`, "POST");
          assert.equal(replay.status, 200);
          assert.equal(replay.body.journalEntryId, posted.body.journalEntryId);
          assert.equal(replay.body.idempotentReplay, true);
          const settlement = result(await db.execute(sql`SELECT journal_entry_id FROM contracting_accounting_settlements
            WHERE company_id = ${company} AND source_voucher_type = ${direction}
              AND source_voucher_id = ${created.body.id} AND status = 'posted'`));
          assert.equal(settlement.length, 1);
          assert.equal(settlement[0].journal_entry_id, posted.body.journalEntryId);
          const linesInJe = result(await db.execute(sql`SELECT account_id, debit, credit FROM journal_entry_lines
            WHERE entry_id = ${posted.body.journalEntryId}`));
          assert.equal(linesInJe.length, 3, "treasury + contracting + ordinary invoice allocation");
          const unpost = await send(`${endpoint}/${created.body.id}/unpost?companyId=${company}`, "POST");
          assert.equal(unpost.status, 200, JSON.stringify(unpost.body));
          assert.equal(result(await db.execute(sql`SELECT count(*)::int AS count FROM contracting_accounting_settlements
            WHERE company_id = ${company} AND source_voucher_type = ${direction}
              AND source_voucher_id = ${created.body.id} AND status = 'posted'`))[0].count, 0);
          const repost = await send(`${endpoint}/${created.body.id}/post?companyId=${company}`, "POST");
          assert.equal(repost.status, 200, JSON.stringify(repost.body));
          assert.notEqual(repost.body.journalEntryId, posted.body.journalEntryId);
          assert.equal(result(await db.execute(sql`SELECT status FROM journal_entries
            WHERE id = ${posted.body.journalEntryId}`))[0].status, "draft",
            "prior journal remains as immutable draft evidence, not deleted");
        }
      } finally { server.close(); }
    } finally {
      // The disposable cluster is dropped by the harness. Keep accounting
      // evidence intact until that drop rather than cascading test journals.
      await pool.end();
    }
  });