import test from 'node:test';
import assert from 'node:assert/strict';
import { assigneeIds, resolveAssigneeNames } from '../src/lib/crm-assignments.js';
import { createOpportunityFromData } from '../src/services/twenty.service.js';
const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002';
const members = [ {id:a,deletedAt:null,name:{firstName:'Alex',lastName:'A'}},
  {id:b,deletedAt:null,name:{firstName:'Sam',lastName:'B'}} ];
test('intake resolves ordered unique people to the two user relations', () => {
  assert.deepEqual(resolveAssigneeNames(['Sam','Alex','Sam'],members), {primaryAssigneeUserId:b,secondaryAssigneeUserId:a});
  assert.deepEqual(resolveAssigneeNames([],members), {primaryAssigneeUserId:null,secondaryAssigneeUserId:null});
  assert.throws(()=>resolveAssigneeNames(['Unknown'],members), /UNRESOLVED/);
  assert.throws(()=>resolveAssigneeNames(['Alex'],[...members,{...members[1],name:{firstName:'Alex',lastName:'B'}}]), /UNRESOLVED/);
  assert.throws(()=>resolveAssigneeNames(['Sam'],[...members.map(m=>({...m,deletedAt:'2026-01-01'}))]), /UNRESOLVED/);
});
test('missing relation fields are rejected while explicitly unassigned leads ignore retired tags',()=>{
  assert.throws(()=>assigneeIds({assignedTo:['Alex']}),/FIELDS_MISSING/);
  assert.deepEqual(assigneeIds({primaryAssigneeUserId:null,secondaryAssigneeUserId:null,assignedTo:['Alex']}),[]);
  assert.throws(()=>assigneeIds({primaryAssigneeUserId:'Alex',secondaryAssigneeUserId:null}),/INVALID/);
});
test('RFQ HTTP writes only the new relation fields and rejects legacy assignment payloads before POST',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;const payload=JSON.parse(options.body);
    assert.equal(payload.primaryAssigneeUserId,a);assert.equal(payload.secondaryAssigneeUserId,b);
    assert.ok(!Object.hasOwn(payload,'assignedTo'));assert.ok(!Object.hasOwn(payload,'secondaryAssignee'));
    return {ok:true,json:async()=>({data:{createOpportunity:{id:a}}})};};
  try{
    await createOpportunityFromData({name:'Synthetic',primaryAssigneeUserId:a,secondaryAssigneeUserId:b});
    await assert.rejects(createOpportunityFromData({assignedTo:['Alex']}),/LEGACY/);
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
