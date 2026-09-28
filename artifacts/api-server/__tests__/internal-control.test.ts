import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { internalControlAllowed, internalControlBranchAllowed, internalControlDocumentUrl, internalControlEventKey, exceedsThreshold, reviewerTransition } from "../src/lib/internalControlPolicy.js";
import { validateRuleConfig, INTERNAL_CONTROL_RULES } from "../src/lib/internalControlRules.js";

test("module defaults off, including admins; ordinary user must explicitly have master + child",()=>{
  assert.equal(internalControlAllowed({role:"admin"}),false);
  assert.equal(internalControlAllowed({role:"superadmin",companyMenuPermissions:{internal_control:false}}),false);
  const user={role:"user",companyMenuPermissions:{internal_control:true},permissions:{internal_control_cases:{view:true}}};
  assert.equal(internalControlAllowed(user,"internal_control_cases"),false);
  assert.equal(internalControlAllowed({...user,permissions:{...user.permissions,internal_control:{view:true}}},"internal_control_cases"),true);
  assert.equal(internalControlAllowed({...user,permissions:null}),false);
  assert.equal(internalControlAllowed({...user,role:"admin"}),true);
});
test("branch evidence is fail closed including unknown branch",()=>{
  const u={viewAllBranches:false,branchIds:[2]};
  assert.equal(internalControlBranchAllowed(u,2),true);
  assert.equal(internalControlBranchAllowed(u,3),false);
  assert.equal(internalControlBranchAllowed(u,null),false);
  assert.equal(internalControlBranchAllowed({...u,viewAllBranches:true},null),true);
});
test("explicit admin master revocation applies only to internal control",()=>{
  const u={role:"admin",companyMenuPermissions:{internal_control:true},permissions:{internal_control:{view:false}}};
  assert.equal(internalControlAllowed(u),false);
  assert.equal(internalControlAllowed(u,"internal_control_review","edit"),false);
  assert.equal(internalControlAllowed({...u,permissions:null}),true);
});
test("source links use real routes and reject invalid ids",()=>{
  assert.equal(internalControlDocumentUrl("sales_invoices",4),"/sales/invoices/4");
  assert.equal(internalControlDocumentUrl("journal_entries",4),"/accounting/journals/4");
  assert.equal(internalControlDocumentUrl("contracting_guarantees",4,2),"/contracting/projects/2?tab=guarantees");
  assert.equal(internalControlDocumentUrl("stock_adjustments",4),"/inventory/adjustments");
  assert.equal(internalControlDocumentUrl("sales_invoices","//evil"),null);
  assert.equal(internalControlDocumentUrl("audit_log",4),null);
});
test("idempotency key stable per source event; database uniqueness includes company and rule",()=>{
  assert.equal(internalControlEventKey("audit_log",23),internalControlEventKey("audit_log",23));
  assert.notEqual(internalControlEventKey("audit_log",23),internalControlEventKey("audit_log",24));
  const schema=readFileSync(new URL("../../../lib/db/src/schema/internalControl.ts",import.meta.url),"utf8");
  assert.match(schema,/\.on\(t\.companyId, t\.ruleKey, t\.eventKey\)/);
});
test("thresholds explicit, exact boundary not flagged",()=>{
  assert.equal(exceedsThreshold(100,null),false);
  assert.equal(exceedsThreshold(100,100),false);
  assert.equal(exceedsThreshold(101,100),true);
  assert.equal(exceedsThreshold("bad",100),false);
  assert.throws(()=>validateRuleConfig({query:"DELETE"}));
  assert.throws(()=>validateRuleConfig({threshold:-1}));
  assert.throws(()=>validateRuleConfig({excludedUserIds:[-1]}));
  assert.equal(INTERNAL_CONTROL_RULES.find(r=>r.key==="same_creator_approver")?.enabled,false);
});
test("review lifecycle cannot silently reopen resolved cases and ignore needs reason",()=>{
  assert.equal(reviewerTransition("open","review"),"in_review");
  assert.equal(reviewerTransition("in_review","resolve"),"resolved");
  assert.throws(()=>reviewerTransition("open","ignore"," "));
  assert.equal(reviewerTransition("open","ignore","duplicate confirmed"),"ignored");
  assert.throws(()=>reviewerTransition("resolved","review"));
  assert.equal(reviewerTransition("resolved","reopen"),"open");
  assert.equal(reviewerTransition("resolved","note","evidence"),"resolved");
});
test("every mutation and evidence fetch use scoped locked case; engine never writes source tables",()=>{
  const route=readFileSync(new URL("../src/routes/internal-control.ts",import.meta.url),"utf8");
  assert.match(route,/scope\(req,res\).*eq\(cases\.id,id\).*for\("update"\)/);
  assert.match(route,/scope\(req,res\).*eq\(cases\.id,positive/);
  const engine=readFileSync(new URL("../src/lib/internalControlEngine.ts",import.meta.url),"utf8");
  assert.doesNotMatch(engine,/db\.(update|delete)\(/);
  assert.match(engine,/d\.company_id = c\.company_id AND d\.branch_id IS NOT DISTINCT FROM c\.branch_id/);
});