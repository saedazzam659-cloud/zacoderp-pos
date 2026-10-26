import assert from "node:assert/strict";
import test from "node:test";
import { withIdleInTransactionTimeout } from "@workspace/db";

test("external agent connection timeout preserves existing PostgreSQL startup options", () => {
  const source = "postgres://user:pass@db.example.test:5432/erp?sslmode=require&options=-c%20search_path%3Dpublic";
  const configured = new URL(withIdleInTransactionTimeout(source, 300_000));

  assert.equal(configured.searchParams.get("sslmode"), "require");
  assert.equal(
    configured.searchParams.get("options"),
    "-c search_path=public -c idle_in_transaction_session_timeout=300000",
  );
});

test("external agent connection timeout rejects invalid values", () => {
  assert.throws(
    () => withIdleInTransactionTimeout("postgres://user:pass@db.example.test/erp", 0),
    /positive integer/,
  );
});
