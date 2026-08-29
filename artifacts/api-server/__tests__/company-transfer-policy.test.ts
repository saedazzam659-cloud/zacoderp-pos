import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupFailedTransferTarget,
  parseTransferLocation,
  resetTargetZatcaIdentity,
  sameTransferLocation,
  transferLocationKey,
  withoutPortableFiles,
} from "../src/lib/companyTransfer.js";
import { writeTransferAuditSafely } from "../src/lib/companyTransferAudit.js";
import {
  withGuaranteedTransferCleanup,
  withPostSuccessCleanupWarning,
} from "../src/lib/companyTransferCleanup.js";

test("transfer locations support central and initialized-agent identifiers", () => {
  assert.deepEqual(parseTransferLocation("central"), { kind: "central" });
  assert.deepEqual(parseTransferLocation("agent:12"), { kind: "agent", agentId: 12 });
  assert.equal(transferLocationKey({ kind: "agent", agentId: 12 }), "agent:12");
  assert.equal(sameTransferLocation({ kind: "central" }, { kind: "central" }), true);
  assert.equal(sameTransferLocation({ kind: "central" }, { kind: "agent", agentId: 12 }), false);
  assert.throws(() => parseTransferLocation("agent:0"), /غير صالح/);
});

test("direct transfer removes file references rather than leaving broken target links", () => {
  const payload: any = {
    meta: { files: { mode: "references_only", referenced: 2, warning: null } },
    companySettings: { logo: "/objects/company/logo.png", name_ar: "شركة" },
    data: {
      document_archives: [{
        id: 1,
        file_path: "private/company/a.pdf",
        title: "A",
      }],
    },
  };
  const sanitized = withoutPortableFiles(payload);
  assert.equal(sanitized.companySettings.logo, null);
  assert.equal(sanitized.data.document_archives[0].file_path, null);
  assert.equal(sanitized.data.document_archives[0].title, "A");
  assert.equal(sanitized.meta.files.referenced, 0);
  assert.match(sanitized.meta.files.warning, /استبعاد 2/);
});

test("transfer keeps ZATCA business history but clears device identity and auto-send", () => {
  const payload: any = {
    meta: { files: { mode: "references_only", referenced: 0, warning: null } },
    companySettings: {
      name_ar: "شركة",
      serial_number: "EGS-1",
      zatca_csid_token: "secret",
      zatca_compliance_request_id: "req",
      auto_send_zatca_after_post: true,
    },
    data: {
      invoices: [{ id: 1, invoice_hash: "business-evidence", xml_content: "<Invoice/>" }],
    },
  };
  const sanitized = resetTargetZatcaIdentity(payload);
  assert.equal(sanitized.companySettings.serial_number, null);
  assert.equal(sanitized.companySettings.zatca_csid_token, null);
  assert.equal(sanitized.companySettings.zatca_compliance_request_id, null);
  assert.equal(sanitized.companySettings.auto_send_zatca_after_post, false);
  assert.equal(sanitized.data.invoices[0].invoice_hash, "business-evidence");
  assert.equal(sanitized.data.invoices[0].xml_content, "<Invoice/>");
});

test("failed transfer cleanup reports the suspended target id when deletion cannot be confirmed", async () => {
  await assert.rejects(
    cleanupFailedTransferTarget(912, new Error("restore failed"), {
      deleteTarget: async () => {},
      targetExists: async () => true,
    }),
    /restore failed.*912.*بقي سجل الشركة الهدف/,
  );
});

test("audit failure never converts an already-completed transfer into a failure", async () => {
  let observed: unknown = null;
  const logged = await writeTransferAuditSafely(
    async () => { throw new Error("audit database unavailable"); },
    (error) => { observed = error; },
  );
  assert.equal(logged, false);
  assert.match(String((observed as Error)?.message), /audit database unavailable/);
});

test("temporary transfer cleanup runs even when package work fails", async () => {
  let cleaned = false;
  await assert.rejects(
    withGuaranteedTransferCleanup(
      async () => { throw new Error("upload failed"); },
      async () => { cleaned = true; },
    ),
    /upload failed/,
  );
  assert.equal(cleaned, true);
});

test("temporary transfer cleanup failure is explicit after package failure", async () => {
  await assert.rejects(
    withGuaranteedTransferCleanup(
      async () => { throw new Error("download failed"); },
      async () => { throw new Error("remote rm failed"); },
    ),
    /download failed.*تعذّر تنظيف ملف النقل المؤقت.*remote rm failed/,
  );
});

test("post-restore cleanup failure preserves success and returns a warning", async () => {
  const settled = await withPostSuccessCleanupWarning(
    async () => ({ restored: true }),
    async () => { throw new Error("remote rm failed"); },
  );
  assert.deepEqual(settled.value, { restored: true });
  assert.match(settled.cleanupWarning ?? "", /اكتملت الاستعادة.*remote rm failed/);
});