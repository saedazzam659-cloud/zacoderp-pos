import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentWhatsAppPhone,
  resolveWhatsAppContact,
  type WhatsAppContact,
} from "../src/lib/whatsappContact.ts";

const central: WhatsAppContact = {
  digits: "966538089122",
  international: "+966538089122",
  display: "+966 53 808 9122",
  waHref: "https://wa.me/966538089122?text=existing",
  telHref: "tel:+966538089122",
  isAgent: false,
};

test("normalizes Egyptian and Saudi local mobile numbers without guessing", () => {
  const egypt = normalizeAgentWhatsAppPhone("01000903159");
  assert.equal(egypt?.digits, "201000903159");
  assert.equal(egypt?.telHref, "tel:+201000903159");
  assert.match(egypt?.waHref ?? "", /^https:\/\/wa\.me\/201000903159\?/);
  assert.equal(normalizeAgentWhatsAppPhone("0538089122")?.digits, "966538089122");
  assert.equal(normalizeAgentWhatsAppPhone("020 1234 5678"), null);
});

test("accepts explicit international forms and rejects malformed values", () => {
  assert.equal(normalizeAgentWhatsAppPhone("00966538089122")?.digits, "966538089122");
  assert.equal(normalizeAgentWhatsAppPhone("+201000903159")?.digits, "201000903159");
  assert.equal(normalizeAgentWhatsAppPhone("+44 7700 900123")?.digits, "447700900123");
  assert.equal(normalizeAgentWhatsAppPhone("call 01000903159"), null);
});

test("render decision preserves central contact and fails closed for agents", () => {
  assert.equal(resolveWhatsAppContact({ isAgentDomain: false }, central), central);
  assert.equal(resolveWhatsAppContact({ isAgentDomain: true }, central), null);
  assert.equal(resolveWhatsAppContact({ isAgentDomain: true, contactPhone: "not a phone" }, central), null);
  assert.equal(
    resolveWhatsAppContact({ isAgentDomain: true, contactPhone: "01000903159" }, central)?.isAgent,
    true,
  );
  assert.equal(resolveWhatsAppContact(null, central), null);
});