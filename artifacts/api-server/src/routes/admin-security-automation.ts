import { Router } from "express";
import { centralScope, monitor, instanceId, limitations, settingsPayload, saveSettings } from "../lib/securityAutomation.js";
import { validateSettings } from "../lib/securityAutomationCore.js";

const router=Router();
let lastAccess=0;
router.use((req,res,next)=>{
  if(!req.adminUser || req.adminUser.role!=="superadmin") { res.status(403).json({error:"SuperAdmin required"}); return; }
  if(!centralScope() || req.query.agent) { res.status(403).json({error:"Central platform scope only"}); return; }
  if(Date.now()-lastAccess>=60_000) { lastAccess=Date.now(); monitor.addEvent("monitor_access",undefined,lastAccess,req.adminUser.id); }
  next();
});
router.get("/summary",(_req,res)=>res.json({mode:monitor.settings.enabled?"monitor":"off",instanceId,scope:"central-web-observed",limitations,capabilities:{captcha:false,blocking:false,throttling:false,revoke:false},...monitor.snapshot()}));
router.get("/sessions/:id",(req,res)=>{
  monitor.sweep();
  const session=monitor.sessions.get(String(req.params.id))?.session;
  if(!session) { res.status(404).json({error:"Observation expired or absent on this instance"}); return; }
  res.json({session,events:monitor.events.filter(e=>e.sessionId===session.id).reverse(),instanceId});
});
router.get("/settings",(_req,res)=>res.json(settingsPayload()));
router.put("/settings",async(req,res)=>{
  if(!validateSettings(req.body)) { res.status(400).json({error:"Invalid monitor settings; send all six supported fields within documented bounds"}); return; }
  try { await saveSettings(req.body,req.adminUser!.id); res.json(settingsPayload()); }
  catch { res.status(503).json({error:"Unable to persist monitor settings; previous local configuration retained"}); }
});
export default router;