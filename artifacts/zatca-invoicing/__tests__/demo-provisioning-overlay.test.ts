import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname ?? __dirname, "..", "src");
const login = readFileSync(join(root, "pages", "Login.tsx"), "utf8");
const overlay = readFileSync(join(root, "components", "DemoProvisioningOverlay.tsx"), "utf8");

test("demo preparation is probed before the real login and shown only when requested", () => {
  assert.ok(login.includes('intent: "check_demo_preparation"'));
  assert.ok(login.indexOf("await checkDemoPreparation") < login.indexOf("await login(trimmedUsername"));
  assert.ok(login.includes("setShowDemoPreparation(true)"));
  assert.ok(login.includes("setDemoPreparationProgress(100)"));
  assert.ok(login.includes("<DemoProvisioningOverlay"));
});

test("the first-device overlay contains the requested reassurance and accessible progress", () => {
  assert.ok(overlay.includes("جارٍ تجهيز حسابك التجريبي"));
  assert.ok(overlay.includes("نقوم الآن بإعداد حساب الديمو وتجهيز البيانات لأول استخدام"));
  assert.ok(overlay.includes("سيتم الدخول تلقائيًا عند اكتمال التجهيز"));
  assert.ok(overlay.includes('role="progressbar"'));
  assert.ok(overlay.includes('dir="rtl"'));
  assert.ok(overlay.includes("motion-reduce:animate-none"));
});