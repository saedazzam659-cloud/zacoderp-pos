import {test} from "node:test";
import assert from "node:assert/strict";
import {INTERNAL_CONTROL_EXTENDED_SOURCES as sources,overduePrepaidSlot} from "../src/lib/internalControlExtendedSources.js";
import {INTERNAL_CONTROL_RULES} from "../src/lib/internalControlRules.js";

test("every extended source has one supported rule with unchanged API fields",()=>{
  for(const key of Object.keys(sources)){
    const rule=INTERNAL_CONTROL_RULES.find(r=>r.key===key);
    assert.ok(rule?.supported,key);
    if(sources[key].condition.includes("$threshold")){assert.ok(rule.thresholdUnit);assert.equal(rule.enabled,false);}
  }
  assert.equal(new Set(INTERNAL_CONTROL_RULES.map(r=>r.key)).size,INTERNAL_CONTROL_RULES.length);
});
test("overdue prepaid mirrors generator legacy cap, reserved periods, future windows and grace",()=>{
  const schedule=[{ym:"2026-02",isoDate:"2026-02-22"},{ym:"2026-03",isoDate:"2026-03-22"}];
  assert.equal(overduePrepaidSlot(schedule,[],"2026-02-20",0),null);
  assert.equal(overduePrepaidSlot(schedule,[],"2026-02-22",0),null);
  assert.equal(overduePrepaidSlot(schedule,[],"2026-02-25",3),null);
  assert.equal(overduePrepaidSlot(schedule,[],"2026-02-26",3)?.ym,"2026-02");
  assert.equal(overduePrepaidSlot(schedule,["2026-02"],"2026-03-01",0),null);
  assert.equal(overduePrepaidSlot(schedule,["2026-01","2026-02"],"2026-05-01",0),null);
  assert.equal(overduePrepaidSlot([],[],"2026-05-01",0),null);
});
test("contract comparisons reject modified historical policy, amendments, unapproved excess and foreign scope",()=>{
  assert.match(sources.bill_exceeds_unchanged_contract.query,/updated_at,b.updated_at\)<=s.created_at/);
  assert.match(sources.bill_exceeds_unchanged_contract.query,/parent_contract_id IS NULL/);
  assert.match(sources.bill_exceeds_unchanged_contract.query,/b.contractor_id=s.contractor_id/);
  assert.match(sources.bill_exceeds_unchanged_contract.condition,/reversal_journal_entry_id IS NULL/);
  assert.match(sources.bill_quantity_exceeded.query,/q.updated_at<=l.created_at AND q.unit=l.unit_snapshot/);
  assert.match(sources.bill_quantity_exceeded.query,/x.base_line_id=q.id/);
  assert.match(sources.bill_quantity_exceeded.condition,/excess_approved IS FALSE/);
});
test("guarantee comparison uses actual automatic mode snapshots; stock counts use actual-vs-system and only posted",()=>{
  assert.match(sources.guarantee_percent_mismatch.condition,/calculation_mode='auto'/);
  assert.match(sources.guarantee_percent_mismatch.condition,/base_amount IS NOT NULL/);
  assert.match(sources.guarantee_percent_mismatch.condition,/override_reason/);
  assert.match(sources.stock_count_difference.query,/actual_qty-l.system_qty/);
  assert.match(sources.stock_count_difference.condition,/status='posted'/);
  assert.match(sources.stock_large_transfer.query,/qty\*l.conversion_factor/);
});
test("current absence of project alone is not falsely marked as historical policy violation",()=>{
  const rule=INTERNAL_CONTROL_RULES.find(r=>r.key==="missing_mandatory_project");
  assert.equal(rule?.supported,false);
  assert.equal(INTERNAL_CONTROL_RULES.find(r=>r.key==="prepaid_missing_reference")?.enabled,false);
});