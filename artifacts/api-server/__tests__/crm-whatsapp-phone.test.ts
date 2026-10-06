import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCrmWhatsAppPhone } from "../src/lib/crmWhatsAppPhone.ts";

test("normalizes international prefixes and phone punctuation for deduplication", () => {
  assert.equal(normalizeCrmWhatsAppPhone("+20 100-903-159")?.normalizedPhone, "20100903159");
  assert.equal(normalizeCrmWhatsAppPhone("0020100903159")?.normalizedPhone, "20100903159");
});

test("normalizes Arabic numerals and rejects invalid or out-of-range numbers", () => {
  assert.equal(normalizeCrmWhatsAppPhone("+٢٠ ١٠٠٩٠٣١٥٩")?.normalizedPhone, "20100903159");
  assert.equal(normalizeCrmWhatsAppPhone("call 01000903159"), null);
  assert.equal(normalizeCrmWhatsAppPhone("123"), null);
  assert.equal(normalizeCrmWhatsAppPhone("1234567890123456"), null);
});
