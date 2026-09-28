import { centralDb, getActiveExternalDb, systemSettingsTable, auditLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Request, Response } from "express";
import { SecurityMonitor, defaults, validateSettings, type Settings } from "./securityAutomationCore.js";

export const instanceId=randomUUID();
const moduleName="security_automation_monitor_v1";
const key="security_automation_monitor_v1_settings";
// Checked once at process load; no request filesystem work. Config is a deployment boundary.
const centralRuntime=!process.env.ZACOD_AGENT_CONFIG && !existsSync("/opt/zacod/config.json");
export const centralScope=()=>centralRuntime && !getActiveExternalDb();
const queue: (typeof auditLogTable.$inferInsert)[]=[];
export let persistenceError:string|null=null;
export const monitor=new SecurityMonitor((event,session,actorId)=>{
  if(queue.length>=100) { monitor.droppedEvents++; return; }
  queue.push({module:moduleName,action:event.type,userId:session?.userId??actorId??null,companyId:session?.companyId??null,metadata:{...event,instanceId,scope:"central-web-observed"}});
});
let busy=false;
let lastCleanup=0;
let settingsVersion=0;
async function background() {
  if(!centralRuntime || busy) return;
  busy=true;
  try {
    const version=settingsVersion;
    const [row]=await centralDb.select().from(systemSettingsTable).where(eq(systemSettingsTable.key,key)).limit(1);
    if(row) { const parsed=JSON.parse(row.value); if(!validateSettings(parsed)) throw new Error("Invalid monitor settings"); if(version===settingsVersion) monitor.settings=parsed; }
    const batch=queue.splice(0,25);
    if(batch.length) {
      try { await centralDb.insert(auditLogTable).values(batch); }
      catch(error) { monitor.droppedEvents+=batch.length; throw error; }
    }
    monitor.sweep();
    if(Date.now()-lastCleanup>3_600_000) {
      // Indexed module/time selection, at most 500 OWN records. Never generic audit retention.
      const cutoff=new Date(Date.now()-monitor.settings.retentionDays*86400000);
      await centralDb.execute(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE module=${moduleName} AND created_at < ${cutoff} ORDER BY created_at LIMIT 500)`);
      lastCleanup=Date.now();
    }
    persistenceError=null;
  } catch { persistenceError="Monitor settings/audit persistence unavailable"; }
  finally { busy=false; }
}
// Timer is born outside request ALS and always uses explicit centralDb.
if(centralRuntime) {
  const timer=setInterval(()=>void background(),60_000); timer.unref();
  const initial=setTimeout(()=>void background(),1000); initial.unref();
}
export async function saveSettings(settings:Settings, actorId:number) {
  await centralDb.insert(systemSettingsTable).values({key,value:JSON.stringify(settings)}).onConflictDoUpdate({target:systemSettingsTable.key,set:{value:JSON.stringify(settings),updatedAt:new Date()}});
  monitor.settings={...settings};
  settingsVersion++;
  monitor.addEvent("settings_changed",undefined,Date.now(),actorId);
}
export const settingsPayload=()=>({settings:{...monitor.settings},defaults,instanceId,persistenceError});
const attached=Symbol("security-monitor-attached");
const families=new Set(["invoices","sales","purchases","customers","suppliers","items","inventory","reports","dashboard","accounts","journal-entries"]);
export function observeWebRequest(req:Request,res:Response,channel:unknown) {
  if(!centralScope() || !monitor.settings.enabled || channel!=="web" || !req.authUser || req.isKiosk || req.query.agent) return;
  // Client hints can only REMOVE coverage, never authorize monitoring/enforcement.
  if(req.headers["x-kiosk-token"] || req.headers["x-pos-device-id"] ||
    (req.headers["x-app-channel"] && req.headers["x-app-channel"]!=="web") ||
    /electron|zacod.*(?:desktop|pos)/i.test(String(req.headers["user-agent"]??"").slice(0,256))) return;
  const r=req as Request & {[attached]?:boolean};
  if(r[attached]) return;
  const path=(req.originalUrl??"").slice(0,512).split("?",1)[0];
  const parts=path.split("/");
  if(parts[1]!=="api" || !families.has(parts[2])) return;
  // Explicit exclusions even inside business route families.
  if(/(?:pos|desktop|mobile|sync|agent|kiosk|control)/i.test(path)) return;
  r[attached]=true;
  const {id:userId,companyId}=req.authUser;
  const pageRaw=req.query.page;
  const page=typeof pageRaw==="string" && /^\d{1,7}$/.test(pageRaw)?Number(pageRaw):null;
  const ua=/headless|playwright|puppeteer|selenium|bot|crawler/i.test(String(req.headers["user-agent"]??"").slice(0,256));
  const exported=/(?:^|\/)(?:export|download|csv)(?:\/|$)/i.test(path);
  const family=parts[2];
  res.once("finish",()=>{ try { monitor.record({userId,companyId,family,page,ua,exported,denied:res.statusCode===401||res.statusCode===403}); } catch { /* Observation must never change response semantics. */ } });
}
export const limitations=[
  "Per-instance bounded memory; resets on restart; not a distributed security control.",
  "Trusted persisted web channel on allowlisted central ERP routes only; shared credentials cannot prove browser/device identity.",
  "Excludes external agents, mobile channels, kiosk, POS/desktop/control planes and unknown channels.",
  "Legacy identities aggregate by user/company, not actual sessions. Login time is unknown.",
  "Only authenticated response denials, page-number sequences and export route attempts are observed; not navigation, session reuse or all exports.",
  "Monitor only: CAPTCHA, throttling, blocking and session revocation are unsupported.",
  "Settings refresh per instance every 60 seconds; retained audit summaries are not included in the in-memory timeline."
];