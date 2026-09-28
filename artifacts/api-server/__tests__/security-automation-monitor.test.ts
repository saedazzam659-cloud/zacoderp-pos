import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { SecurityMonitor, defaults, validateSettings } from "../src/lib/securityAutomationCore.js";

const input={userId:1,companyId:1,family:"invoices",page:null as number|null,denied:false,exported:false,ua:false};
test("settings reject unknown fields, invalid thresholds, unsupported retention",()=>{
  assert.ok(validateSettings(defaults));
  for(const v of [{...defaults,foo:true},{...defaults,requestsPerMinute:0},{...defaults,enabled:"yes"},{...defaults,retentionDays:14}]) assert.equal(validateSettings(v),false);
});
test("single UA/rate signals cannot conclude suspicious; combination emits bounded cooldown summaries",()=>{
  const m=new SecurityMonitor();
  m.record({...input,ua:true},1000);
  assert.equal(m.snapshot(1000).sessions[0].status,"monitoring");
  for(let i=0;i<200;i++) m.record(input,1000+i);
  assert.equal(m.events.length,1);
  assert.equal(m.snapshot(1300).sessions[0].status,"suspicious");
  assert.equal(m.snapshot(62_000).sessions[0].status,"normal");
});
test("sequential pages, export attempts and denials combine; events contain no request data",()=>{
  const m=new SecurityMonitor();
  for(let i=0;i<12;i++) m.record({...input,page:i,denied:true,exported:true},1000+i);
  const s=m.snapshot(1100).sessions[0];
  assert.equal(s.status,"high_risk");
  assert.ok(s.signals.includes("sequential_pagination"));
  assert.equal(s.loginAt,null);
  assert.equal(m.events.length,1);
  assert.ok(!JSON.stringify(m.events).includes("invoices"));
});
test("off, window expiry, TTL, identity and event bounds",()=>{
  const m=new SecurityMonitor();
  m.settings.enabled=false;m.record(input,1000);assert.equal(m.sessions.size,0);
  m.settings.enabled=true;
  for(let i=0;i<2500;i++) m.record({...input,userId:i},1000);
  assert.equal(m.sessions.size,2000);
  for(let i=0;i<600;i++) m.addEvent("monitor_access",undefined,1000);
  assert.equal(m.events.length,500);
  m.sweep(1_802_000);assert.equal(m.sessions.size,0);
});
test("static boundary: once-only finish, no per-request SQL and unchanged auth selection except channel",()=>{
  const source=readFileSync(new URL("../src/lib/securityAutomation.ts",import.meta.url),"utf8");
  const body=source.split("export function observeWebRequest")[1].split("export const limitations")[0];
  assert.ok(body.includes('res.once("finish"'));
  assert.ok(body.includes('channel!=="web"'));
  assert.ok(body.includes("centralScope()"));
  assert.ok(body.includes("r[attached]"));
  assert.ok(!/\bawait\b|\.insert\(|\.select\(|\.update\(/.test(body));
  const auth=readFileSync(new URL("../src/middleware/auth.ts",import.meta.url),"utf8");
  assert.match(auth,/try\s*\{\s*observeWebRequest\(req, _res, user\.sessionChannel\);\s*\}\s*catch/);
});
test("local microbenchmark: counter-only baseline versus bounded monitor, no DB or server",()=>{
  const n=100_000;
  const m=new SecurityMonitor();
  for(let i=0;i<10_000;i++) m.record(input,1000);
  let counter=0;
  const heapBefore=process.memoryUsage().heapUsed;
  const cpuBefore=process.cpuUsage();
  let t=performance.now();
  for(let i=0;i<n;i++) counter++;
  const baselineMs=performance.now()-t;
  t=performance.now();
  for(let i=0;i<n;i++) m.record(input,1000+i%1000);
  const monitorMs=performance.now()-t;
  const cpu=process.cpuUsage(cpuBefore);
  console.log(JSON.stringify({benchmark:"in-memory only, not HTTP/auth/database; baseline is simple increment",n,counter,baselineMs,monitorMs,addedMicrosecondsPerObservation:(monitorMs-baselineMs)*1000/n,observationsPerSecond:n*1000/monitorMs,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,heapDeltaBytes:process.memoryUsage().heapUsed-heapBefore,requestDatabaseOperations:0}));
  assert.equal(m.events.length,0);
});