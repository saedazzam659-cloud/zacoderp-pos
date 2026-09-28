import { Router, type Request, type Response, type NextFunction } from "express";
import { db, internalControlCasesTable as cases, internalControlHistoryTable as history, internalControlRulesTable as rules, usersTable, userBranchesTable, branchesTable } from "@workspace/db";
import { and, or, isNull, eq, inArray, desc, gte, lte, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { internalControlAllowed, internalControlBranchAllowed, internalControlDocumentUrl, reviewerTransition } from "../lib/internalControlPolicy.js";
import { getInternalControlRules, internalControlEnabled, registerInternalControlDatasource, scanInternalControl } from "../lib/internalControlEngine.js";
import { validateRuleConfig } from "../lib/internalControlRules.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(extractAuth);
router.use(async (req,res,next) => {
  const cid = resolveCompanyId(req);
  if (!cid || !req.authUser || req.isKiosk) { res.status(403).json({error:"يجب اختيار شركة وحساب مستخدم"}); return; }
  // Live company upper bound, including superadmin acting within a company.
  if (!await internalControlEnabled(cid)) { res.status(403).json({error:"وحدة الرقابة الداخلية غير مفعلة للشركة"}); return; }
  req.authUser.companyMenuPermissions = {...req.authUser.companyMenuPermissions,internal_control:true};
  if (!internalControlAllowed(req.authUser)) { res.status(403).json({error:"لا تملك صلاحية مشاهدة الرقابة الداخلية"}); return; }
  res.locals.companyId=cid;
  registerInternalControlDatasource();
  next();
});
function permission(key:string,action="view") {
  return (req:Request,res:Response,next:NextFunction) => {
    if (!internalControlAllowed(req.authUser,key,action)) { res.status(403).json({error:"لا تملك صلاحية هذا الإجراء"}); return; } next();
  };
}
function positive(value:unknown,label:string):number {
  const n=Number(value); if(!Number.isSafeInteger(n)||n<1) throw new Error(`${label} غير صالح`); return n;
}
function scope(req:Request,res:Response) {
  const predicates:any[]=[eq(cases.companyId,res.locals.companyId)];
  if (!req.authUser!.viewAllBranches) predicates.push(req.authUser!.branchIds.length ? inArray(cases.branchId,req.authUser!.branchIds) : sql`false`);
  return predicates;
}
function filters(req:Request,res:Response) {
  const p=scope(req,res),q=req.query;
  for(const [key,col] of Object.entries({branchId:cases.branchId,userId:cases.userId,projectId:cases.projectId,customerId:cases.customerId,supplierId:cases.supplierId})) if(q[key]!=null) p.push(eq(col,positive(q[key],key)));
  if(q.category ?? q.type) {
    const category=String(q.category ?? q.type);
    const groups:Record<string,string[]>={documents:["post_approval","cancelled","master_data"],anomalies:["sales","purchases","operations"],project_alerts:["projects","guarantees","advances"]};
    p.push(inArray(cases.category,groups[category]??[category]));
  }
  if(q.status) {if(!["open","in_review","resolved","ignored"].includes(String(q.status))) throw new Error("حالة غير صالحة"); p.push(eq(cases.status,String(q.status)));}
  if(q.severity) {if(!["low","medium","high","critical"].includes(String(q.severity))) throw new Error("خطورة غير صالحة"); p.push(eq(cases.severity,String(q.severity)));}
  for(const [key,op] of [["from",gte],["to",lte]] as const) if(q[key]) {
    let text=String(q[key]); if(key==="to" && /^\d{4}-\d{2}-\d{2}$/.test(text)) text+="T23:59:59.999Z";
    const date=new Date(text); if(!Number.isFinite(date.getTime())) throw new Error("تاريخ غير صالح"); p.push(op(cases.occurredAt,date));
  }
  return and(...p);
}
function pagination(req:Request) {
  return {page:req.query.page?positive(req.query.page,"page"):1,limit:Math.min(req.query.limit?positive(req.query.limit,"limit"):25,100)};
}
function capabilities(req:Request) {
  return {...Object.fromEntries(["internal_control","internal_control_cases","internal_control_review","internal_control_ignore","internal_control_reopen","internal_control_rules","internal_control_log","internal_control_export"].map(key=>[key,internalControlAllowed(req.authUser,key,key==="internal_control_export"?"export":["internal_control_review","internal_control_ignore","internal_control_reopen"].includes(key)?"edit":"view")])),
    internal_control_rules_edit:internalControlAllowed(req.authUser,"internal_control_rules","edit")};
}
function listCase(row:any) { const {evidence,...rest}=row; return {...rest,documentUrl:internalControlDocumentUrl(row.source,row.documentId,row.projectId)}; }
router.get("/lookups",async(req,res)=>{
  const cid=res.locals.companyId;
  const branches=await db.select({id:branchesTable.id,name:branchesTable.nameAr}).from(branchesTable).where(and(eq(branchesTable.companyId,cid),
    req.authUser!.viewAllBranches?undefined:inArray(branchesTable.id,req.authUser!.branchIds.length?req.authUser!.branchIds:[-1])));
  const users=await db.select({id:usersTable.id,username:usersTable.username,name:usersTable.nameAr,role:usersTable.role,permissions:usersTable.permissions,viewAllBranches:usersTable.viewAllBranches,isActive:usersTable.isActive}).from(usersTable).where(eq(usersTable.companyId,cid));
  const links=users.length?await db.select().from(userBranchesTable).where(inArray(userBranchesTable.userId,users.map(u=>u.id))):[];
  res.json({branches,users:users.flatMap(u=>{
    const branchIds=links.filter(b=>b.userId===u.id).map(b=>b.branchId);
    if(!req.authUser!.viewAllBranches&&!u.viewAllBranches&&!branchIds.some(id=>req.authUser!.branchIds.includes(id)))return [];
    const candidate={...u,companyMenuPermissions:{internal_control:true}};
    return [{id:u.id,username:u.username,name:u.name,branchIds,viewAllBranches:u.viewAllBranches,
      canReview:u.isActive&&internalControlAllowed(candidate,"internal_control_cases")&&internalControlAllowed(candidate,"internal_control_review","edit")}];
  })});
});
router.get("/dashboard",permission("internal_control"),async(req,res)=>{
  const where=filters(req,res);
  const [row]=await db.select({
    total:sql<number>`count(*)::integer`,
    open:sql<number>`count(*) filter(where ${cases.status}='open')::integer`,
    highRisk:sql<number>`count(*) filter(where ${cases.severity} in ('high','critical') and ${cases.status} in ('open','in_review'))::integer`,
    inReview:sql<number>`count(*) filter(where ${cases.status}='in_review')::integer`,
    resolved:sql<number>`count(*) filter(where ${cases.status}='resolved')::integer`,
    postApproval:sql<number>`count(*) filter(where ${cases.category}='post_approval')::integer`,
    permissions:sql<number>`count(*) filter(where ${cases.category}='permissions')::integer`,
    cancelled:sql<number>`count(*) filter(where ${cases.category}='cancelled')::integer`,
    projects:sql<number>`count(*) filter(where ${cases.category} in ('projects','guarantees','advances'))::integer`,
    inventory:sql<number>`count(*) filter(where ${cases.category}='inventory')::integer`,
    finance:sql<number>`count(*) filter(where ${cases.category}='finance')::integer`,
    guarantees:sql<number>`count(*) filter(where ${cases.category}='guarantees')::integer`,
    advances:sql<number>`count(*) filter(where ${cases.category}='advances')::integer`,
  }).from(cases).where(where);
  res.json({metrics:row,capabilities:capabilities(req)});
});
router.get("/cases",permission("internal_control_cases"),async(req,res)=>{
  const {page,limit}=pagination(req),where=filters(req,res);
  const [items,[count]]=await Promise.all([db.select().from(cases).where(where).orderBy(desc(cases.id)).limit(limit).offset((page-1)*limit),db.select({total:sql<number>`count(*)::integer`}).from(cases).where(where)]);
  res.json({items:items.map(listCase),total:count.total,page,limit});
});
router.get("/cases/:id",permission("internal_control_cases"),async(req,res)=>{
  const [row]=await db.select().from(cases).where(and(...scope(req,res),eq(cases.id,positive(req.params.id,"id"))));
  if(!row){res.status(404).json({error:"الحالة غير موجودة"});return;}
  const entries=internalControlAllowed(req.authUser,"internal_control_log") ? await db.select().from(history).where(and(eq(history.companyId,res.locals.companyId),eq(history.caseId,row.id))).orderBy(desc(history.id)) : [];
  res.json({case:listCase(row),evidence:row.evidence,history:entries});
});
router.patch("/cases/:id",permission("internal_control_cases"),async(req,res)=>{
  const {action,note,reviewerId,actionTaken}=req.body??{};
  if(!["review","resolve","ignore","reopen","note","assign"].includes(action)){res.status(400).json({error:"إجراء غير صالح"});return;}
  const key=action==="ignore"?"internal_control_ignore":action==="reopen"?"internal_control_reopen":"internal_control_review";
  if(!internalControlAllowed(req.authUser,key,"edit")){res.status(403).json({error:"لا تملك صلاحية هذا الإجراء"});return;}
  if((note!=null && (typeof note!=="string"||note.length>5000))||(actionTaken!=null&&(typeof actionTaken!=="string"||actionTaken.length>5000))) throw new Error("النص غير صالح أو طويل");
  if(action==="note"&&!note?.trim()) throw new Error("الملاحظة مطلوبة");
  const id=positive(req.params.id,"id");
  const updated=await db.transaction(async tx=>{
    const [row]=await tx.select().from(cases).where(and(...scope(req,res),eq(cases.id,id))).for("update");
    if(!row)return null;
    const status=reviewerTransition(row.status,action,note);
    const patch:any={status,updatedAt:new Date()};
    if(action==="assign"){
      const uid=positive(reviewerId,"reviewerId");
      const [reviewer]=await tx.select().from(usersTable).where(and(eq(usersTable.id,uid),eq(usersTable.companyId,res.locals.companyId)));
      if(!reviewer || !reviewer.isActive)throw new Error("المراجع غير نشط أو لا يتبع الشركة");
      const links=await tx.select({branchId:userBranchesTable.branchId}).from(userBranchesTable).where(eq(userBranchesTable.userId,uid));
      const candidate={...reviewer,companyMenuPermissions:{internal_control:true},branchIds:links.map(b=>b.branchId)};
      if(!internalControlAllowed(candidate,"internal_control_cases") || !internalControlAllowed(candidate,"internal_control_review","edit") || !internalControlBranchAllowed(candidate,row.branchId)) throw new Error("المراجع لا يملك صلاحية مراجعة الحالة أو فرعها");
      patch.reviewerId=uid;
    }
    if(note?.trim())patch.reviewerNotes=note.trim();
    if(actionTaken!=null)patch.actionTaken=actionTaken.trim();
    if(["resolved","ignored"].includes(status)&&status!==row.status)patch.resolvedAt=new Date();
    if(action==="reopen")patch.resolvedAt=null;
    const [next]=await tx.update(cases).set(patch).where(and(eq(cases.id,id),eq(cases.companyId,res.locals.companyId))).returning();
    await tx.insert(history).values({companyId:res.locals.companyId,caseId:id,userId:req.authUser!.id,action,fromStatus:row.status,toStatus:status,note:JSON.stringify({note:note?.trim()??null,actionTaken:actionTaken??null,reviewerId:patch.reviewerId??null,previousReviewerId:row.reviewerId})});
    return next;
  });
  if(!updated){res.status(404).json({error:"الحالة غير موجودة"});return;}res.json({case:listCase(updated)});
});
router.get("/rules",permission("internal_control_rules"),async(req,res)=>res.json({items:await getInternalControlRules(res.locals.companyId)}));
router.put("/rules/:key",permission("internal_control_rules","edit"),async(req,res)=>{
  const defs=await getInternalControlRules(res.locals.companyId),rule=defs.find(r=>r.key===req.params.key);
  if(!rule){res.status(404).json({error:"القاعدة غير موجودة"});return;}
  const config=validateRuleConfig(req.body);
  if(!rule.supported){res.status(400).json({error:rule.unsupportedReason});return;}
  const merged={...rule,...config};
  if(merged.enabled&&merged.thresholdUnit&&merged.threshold==null)throw new Error("حدد الحد قبل تفعيل القاعدة");
  if(merged.thresholdUnit==="percent"&&Number(merged.threshold)>100)throw new Error("النسبة لا تتجاوز 100");
  if(merged.thresholdUnit==="days"&&(!Number.isInteger(merged.threshold)||Number(merged.threshold)>3650))throw new Error("عدد الأيام غير صالح");
  if(merged.excludedUserIds.length){
    const users=await db.select({id:usersTable.id}).from(usersTable).where(and(eq(usersTable.companyId,res.locals.companyId),inArray(usersTable.id,merged.excludedUserIds)));
    if(new Set(users.map(u=>u.id)).size!==new Set(merged.excludedUserIds).size)throw new Error("المستخدم المستثنى لا يتبع الشركة");
  }
  await db.transaction(async tx=>{
    const saved=Object.fromEntries(["enabled","severity","threshold","excludedUserIds","excludedRoles"].map(k=>[k,(merged as any)[k]]));
    await tx.insert(rules).values({companyId:res.locals.companyId,key:rule.key,config:saved,updatedBy:req.authUser!.id}).onConflictDoUpdate({target:[rules.companyId,rules.key],set:{config:saved,updatedBy:req.authUser!.id,updatedAt:new Date()}});
    await tx.insert(history).values({companyId:res.locals.companyId,userId:req.authUser!.id,action:"rule_updated",note:JSON.stringify({key:rule.key,config:saved})});
  });
  res.json({rule:merged});
});
router.post("/scan",permission("internal_control_rules","edit"),async(req,res)=>{
  res.json(await scanInternalControl(res.locals.companyId,req.authUser!.viewAllBranches?undefined:req.authUser!.branchIds));
});
router.get("/log",permission("internal_control_log"),async(req,res)=>{
  const {page,limit}=pagination(req),caseFilters=filters(req,res);
  // Rule changes are company-wide, not branch evidence. Only all-branch
  // viewers without case-specific filters can see those history entries.
  const hasCaseFilter=Object.keys(req.query).some(k=>!["page","limit"].includes(k));
  const where=and(eq(history.companyId,res.locals.companyId),or(caseFilters,
    req.authUser!.viewAllBranches&&!hasCaseFilter ? isNull(history.caseId) : sql`false`));
  const [items,[count]]=await Promise.all([
    db.select({history}).from(history).leftJoin(cases,and(eq(cases.id,history.caseId),eq(cases.companyId,history.companyId))).where(where).orderBy(desc(history.id)).limit(limit).offset((page-1)*limit),
    db.select({total:sql<number>`count(*)::integer`}).from(history).leftJoin(cases,and(eq(cases.id,history.caseId),eq(cases.companyId,history.companyId))).where(where),
  ]);
  res.json({items:items.map(r=>r.history),total:count.total,page,limit});
});
router.get("/export",permission("internal_control_export","export"),async(req,res)=>{
  const rows=await db.select().from(cases).where(filters(req,res)).orderBy(desc(cases.id)).limit(10001);
  const columns=["id","ruleKey","category","documentNumber","branchId","projectId","userId","severity","status","description","reason","reviewerId","reviewerNotes","actionTaken","occurredAt"];
  const cell=(v:any)=>`"${String(v??"").replace(/^(?:\s*[=+\-@]|[\t\r])/,"'$&").replace(/"/g,'""')}"`;
  const headings=["رقم الحالة","القاعدة","الفئة","رقم المستند","الفرع","المشروع","المنفذ","الخطورة","الحالة","الوصف","السبب","المراجع","ملاحظات المراجع","الإجراء المتخذ","تاريخ العملية"];
  const text="\uFEFF"+[headings.map(cell).join(","),...rows.slice(0,10000).map(row=>columns.map(c=>cell((row as any)[c])).join(","))].join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",'attachment; filename="internal-control.csv"');
  res.setHeader("X-Export-Truncated",rows.length>10000?"true":"false");res.send(text);
});
router.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
  if(err instanceof Error && !("code" in err) && !("query" in err) && !err.cause && /[\u0600-\u06ff]/.test(err.message)){res.status(400).json({error:err.message});return;}
  logger.error({err},"internal-control request failed");res.status(500).json({error:"تعذر تنفيذ عملية الرقابة الداخلية. يرجى المحاولة أو مراجعة مسؤول النظام."});
});
export default router;