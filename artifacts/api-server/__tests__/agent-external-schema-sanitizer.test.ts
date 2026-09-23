import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSchemaDumpForExternalAgent } from "../src/lib/agentExternalSchema.ts";

test("fresh schema removes the final central column without leaving a trailing comma", () => {
  const dump = `CREATE TABLE public.agent_instances (
    id integer NOT NULL,
    name text,
    invoice_acceleration_mode text DEFAULT 'off'::text NOT NULL,
    invoice_trial_remaining integer
);
ALTER TABLE ONLY public.agent_instances
    ALTER COLUMN invoice_acceleration_mode SET DEFAULT 'off'::text;
CREATE TABLE public.companies (id integer);
`;
  const cleaned = sanitizeSchemaDumpForExternalAgent(dump);
  assert.match(cleaned, /name text\s*\);/);
  assert.doesNotMatch(cleaned, /name text,\s*\)/);
  assert.match(cleaned, /CREATE TABLE public\.companies \(id integer\)/);
  assert.doesNotMatch(cleaned, /invoice_acceleration|invoice_trial_remaining/);
});

test("fresh schema preserves multiline definitions, nested commas and SQL literals", () => {
  const dump = `CREATE TABLE public.agent_instances (
    invoice_acceleration_mode text,
    id integer NOT NULL,
    label text DEFAULT concat('one,two', 'three'),
    invoice_trial_remaining integer DEFAULT (
      1 + (2, 3)::text::integer
    ),
    notes text
);
CREATE FUNCTION public.example() RETURNS text LANGUAGE sql AS $body$
  SELECT 'a;b,c';
$body$;
`;
  const cleaned = sanitizeSchemaDumpForExternalAgent(dump);
  assert.match(cleaned, /id integer NOT NULL,\s*label text DEFAULT concat\('one,two', 'three'\),\s*notes text/);
  assert.match(cleaned, /SELECT 'a;b,c';/);
  assert.doesNotMatch(cleaned, /invoice_acceleration|invoice_trial_remaining/);
});

test("fresh schema rejects unsafe column references and empty tables rather than producing broken SQL", () => {
  assert.throws(
    () => sanitizeSchemaDumpForExternalAgent(`CREATE TABLE public.t (
  id integer,
  CONSTRAINT forbidden CHECK (invoice_trial_remaining > 0)
);`),
    /مرجع غير متوقع/,
  );
  assert.throws(
    () => sanitizeSchemaDumpForExternalAgent("CREATE TABLE public.t (\n  invoice_trial_remaining integer\n);"),
    /جدول بلا أعمدة/,
  );
  assert.throws(
    () => sanitizeSchemaDumpForExternalAgent("CREATE VIEW public.v AS SELECT invoice_trial_remaining FROM public.agent_instances;"),
    /مرجع غير متوقع/,
  );
});