import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const branding = readFileSync(new URL("../src/lib/agentBranding.ts", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../src/pages/Login.tsx", import.meta.url), "utf8");

test("public agent branding initializes on every app entry, independently of title/name", () => {
  assert.match(entry, /import "\.\/lib\/agentBranding"/);
  assert.match(branding, /if \(b\.isAgentDomain && b\.brandLogoUrl\)/);
  assert.ok(branding.indexOf("if (b.isAgentDomain && b.brandLogoUrl)") <
    branding.indexOf("if (!b.isAgentDomain || !b.brandName) return"));
});

test("tab favicon preloads the logo, removes competing icons and preserves default on failure", () => {
  assert.match(branding, /logo\.onload = \(\) => \{/);
  assert.match(branding, /logo\.onerror = \(\) => \{ \/\* Keep the shipped central favicon\. \*\/ \}/);
  assert.match(branding, /icons\.forEach\(other => \{ if \(other !== icon\) other\.remove\(\); \}\)/);
  assert.match(branding, /icon\.removeAttribute\("sizes"\)/);
});

test("agent login logos get larger responsive contain bounds and broken-image fallback", () => {
  assert.match(login, /w-full max-w-\[240px\] h-28 sm:h-36/);
  assert.match(login, /h-20 w-20 sm:h-24 sm:w-24/);
  assert.match(login, /object-contain/);
  assert.equal((login.match(/onError=\{fallbackLogo\}/g) ?? []).length, 2);
  assert.match(login, /event\.currentTarget\.src = defaultLogo/);
});