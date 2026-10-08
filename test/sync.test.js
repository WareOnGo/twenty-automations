import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../src/services/sync-engine.js';

const before = new Date('2026-10-01T00:00:00Z');
const at = '2026-10-08T00:00:00Z';
const opportunity = (id, extra={}) => ({id, createdAt:at, updatedAt:at, stage:'NEW_LEAD', ...extra});
const note = (id, extra={}) => ({id, createdAt:at, updatedAt:at, noteTargets:[], ...extra});

const deferred = operation => ({then:(resolve,reject)=>Promise.resolve().then(operation).then(resolve,reject)});

function fixture(streams={}) {
  const state = {
    checkpoints:new Map(['opportunities','notes','tasks'].map(object => [object,{object,lastUpdatedAt:before}])),
    opportunities:new Map(), raw:new Map(), transitions:[], calls:[],
    failOpps:new Set(), failRaw:new Set(), failActivity:false, stale:0, deleted:0,
  };
  const db = {
    verifiedNumber:{findMany:async()=>[]},
    syncCheckpoint:{
      findUnique:async({where})=>state.checkpoints.get(where.object),
      upsert:async({where,create,update})=>{
        const row=state.checkpoints.get(where.object);
        state.checkpoints.set(where.object,row?{...row,...update}:create);
      },
      updateMany:async({where,data})=>{
        const row=state.checkpoints.get(where.object);
        if(!row || (where.OR && row.lastRunStatus==='locked')) return {count:0};
        Object.assign(row,data); return {count:1};
      },
      create:async({data})=>{
        if(state.checkpoints.has(data.object)) throw new Error('duplicate');
        state.checkpoints.set(data.object,data);
      },
    },
    opportunity:{
      findMany:async({where})=>[...state.opportunities.values()].filter(r=>where.opportunityId.in.includes(r.opportunityId)),
      upsert:({where,update,create})=>deferred(()=>{
        if(state.failOpps.has(where.opportunityId)) throw new Error('injected write failure');
        const row=state.opportunities.get(where.opportunityId);
        state.opportunities.set(where.opportunityId,row?{...row,...update}:create);
      }),
      update:async({where,data})=>{
        if(state.failActivity) throw new Error('injected activity failure');
        Object.assign(state.opportunities.get(where.opportunityId),data);
      },
      count:async({where})=>where.opportunityId?state.stale:state.opportunities.size,
      updateMany:async()=>{state.deleted+=state.stale; return {count:state.stale};},
    },
    stageTransition:{create:({data})=>deferred(()=>state.transitions.push(data))},
    $transaction:async(operations)=>{
      const originalOpportunities=structuredClone(state.opportunities);
      const originalTransitions=structuredClone(state.transitions);
      try { return await Promise.all(operations); }
      catch(error) { state.opportunities=originalOpportunities; state.transitions=originalTransitions; throw error; }
    },
    $executeRaw:async(strings,...values)=>{
      assert.match(strings.join(''),/INSERT INTO public.crm_records/);
      const [object,id,data,links]=values;
      if(state.failRaw.has(id)) throw new Error('injected raw failure');
      state.raw.set(`${object}:${id}`,{data:JSON.parse(data),opportunityIds:JSON.parse(links)});
      return 1;
    },
    $queryRaw:async()=>[{active:0,stale:0}],
  };
  const engine=createSyncEngine({prisma:db,logger:{log(){},warn(){},error(){}},listRecordsSince:async(object,opts)=>{
    state.calls.push({object,...opts});
    if(streams[object] instanceof Error) throw streams[object];
    return streams[object]??[];
  }});
  return {...engine,state,streams};
}

test('keeps full snapshots and refreshes relations with unchanged parent updatedAt',async()=>{
  const f=fixture({opportunities:[opportunity('o',{position:1,searchVector:'raw-index',secondaryAssignee:'SECONDARY_TEAMMATE',timelineActivities:[{id:'event'}],owner:{name:'New owner'}})]});
  f.state.opportunities.set('o',{opportunityId:'o',stage:'NEW_LEAD',data:opportunity('o',{owner:{name:'Old owner'}}),lastMeaningfulUpdateAt:before});
  const result=await f.runSync();
  assert.equal(result.status,'ok');
  assert.deepEqual(f.state.opportunities.get('o').data,f.streams.opportunities[0]);
  assert.equal(f.state.opportunities.get('o').lastMeaningfulUpdateAt.getTime(),before.getTime());
  assert.equal(f.state.transitions.length,0);
  assert.ok(f.state.calls.every(c=>c.sinceISO===null));
});

test('earlier failed opportunity cannot be skipped by a later success or deletion reconciliation',async()=>{
  const f=fixture({opportunities:[opportunity('a'),opportunity('b',{updatedAt:'2026-10-08T00:10:00Z'})]});
  f.state.failOpps.add('a'); f.state.stale=1;
  let result=await f.runSync({full:true});
  assert.equal(result.status,'partial');
  assert.equal(result.streams.opportunities.failures,1);
  assert.equal(f.state.checkpoints.get('opportunities').lastUpdatedAt,before);
  assert.equal(f.state.checkpoints.get('opportunities').lastRunStatus,'error');
  assert.equal(f.state.deleted,0);
  f.state.failOpps.clear(); f.state.stale=0;
  result=await f.runSync();
  assert.equal(result.status,'ok');
  assert.ok(f.state.opportunities.has('a'));
  assert.equal(f.state.checkpoints.get('opportunities').lastUpdatedAt.toISOString(),'2026-10-08T00:10:00.000Z');
});

test('retains complete note/task JSON and unlinked records, with no note truncation in raw storage',async()=>{
  const f=fixture({notes:[note('n',{bodyV2:{markdown:'x'.repeat(5000)},noteTargets:[{targetCompanyId:'company'}]})],tasks:[note('t',{status:'TODO',bodyV2:{markdown:'Complete task body'},taskTargets:[]})]});
  await f.runSync();
  assert.deepEqual(f.state.raw.get('notes:n').data,f.streams.notes[0]);
  assert.deepEqual(f.state.raw.get('tasks:t').data,f.streams.tasks[0]);
});

test('failed raw snapshot keeps checkpoint and retries the record',async()=>{
  const f=fixture({notes:[note('a'),note('b')]}); f.state.failRaw.add('a');
  assert.equal((await f.runSync()).status,'partial');
  assert.equal(f.state.checkpoints.get('notes').lastUpdatedAt,before);
  assert.equal(f.state.checkpoints.get('notes').lastRunStatus,'error');
  f.state.failRaw.clear();
  assert.equal((await f.runSync()).status,'ok');
  assert.ok(f.state.raw.has('notes:a'));
});

test('failed activity application retains checkpoint even when raw write succeeded',async()=>{
  const f=fixture({opportunities:[opportunity('o')],notes:[note('n',{noteTargets:[{targetOpportunityId:'o'}]})]});
  f.state.failActivity=true;
  assert.equal((await f.runSync()).status,'partial');
  assert.ok(f.state.raw.has('notes:n'));
  assert.equal(f.state.checkpoints.get('notes').lastUpdatedAt,before);
});

test('raw records survive missing parents and link on the next cycle without a source timestamp change',async()=>{
  const f=fixture({notes:[note('n',{bodyV2:{markdown:'existing note'},updatedBy:{source:'MANUAL'},noteTargets:[{targetOpportunityId:'later'}]})]});
  assert.equal((await f.runSync()).streams.notes.unresolvedLinks,1);
  f.streams.opportunities=[opportunity('later')];
  await f.runSync();
  assert.equal(f.state.opportunities.get('later').lastNoteText,'existing note');
  assert.equal(f.state.opportunities.get('later').lastMeaningfulUpdateKind,'note');
});

test('malformed/incomplete fetch cannot mark success or soft-delete mirrors',async()=>{
  const f=fixture({opportunities:new Error('incomplete pagination')}); f.state.stale=1;
  assert.equal((await f.runSync({full:true})).status,'partial');
  assert.equal(f.state.checkpoints.get('opportunities').lastUpdatedAt,before);
  assert.equal(f.state.deleted,0);
});

test('deletion safety valve surfaces partial status and leaves watermark intact',async()=>{
  const f=fixture({opportunities:[opportunity('o')]}); f.state.stale=51;
  const result=await f.runSync({full:true});
  assert.equal(result.status,'partial');
  assert.equal(result.streams.opportunities.reconciliationSkipped,true);
  assert.equal(f.state.deleted,0);
  assert.equal(f.state.checkpoints.get('opportunities').lastUpdatedAt,before);
});

test('checkpoint never moves backwards after a full refresh',async()=>{
  const f=fixture({notes:[note('n',{updatedAt:'2026-09-01T00:00:00Z'})]});
  await f.runSync();
  assert.equal(f.state.checkpoints.get('notes').lastUpdatedAt.getTime(),before.getTime());
});


test('first-sight opportunities set a baseline without inventing a historical transition',async()=>{
  const createdAt='2026-08-01T00:00:00Z';
  const f=fixture({opportunities:[opportunity('o',{createdAt,stage:'PROPOSAL_SHARED'})]});
  await f.runSync();
  assert.equal(f.state.transitions.length,0);
  assert.equal(f.state.opportunities.get('o').stageEnteredAt.toISOString(),new Date(createdAt).toISOString());
});

test('real stage change appends exactly once and keeps the source change time through later refreshes',async()=>{
  const f=fixture({opportunities:[opportunity('o',{stage:'PROPOSAL_SHARED',updatedBy:{source:'MANUAL'}})]});
  f.state.opportunities.set('o',{opportunityId:'o',stage:'NEW_LEAD',data:opportunity('o',{stage:'NEW_LEAD'}),stageEnteredAt:before});
  f.state.transitions.push({opportunityId:'o',fromStage:'INQUIRY',toStage:'NEW_LEAD',changedAt:before});
  await f.runSync();
  const entered=f.state.opportunities.get('o').stageEnteredAt;
  assert.equal(f.state.transitions.length,2);
  assert.equal(f.state.transitions[1].fromStage,'NEW_LEAD');
  assert.equal(f.state.transitions[1].toStage,'PROPOSAL_SHARED');
  assert.equal(f.state.transitions[1].changedAt.toISOString(),new Date(at).toISOString());
  f.streams.opportunities[0]={...f.streams.opportunities[0],owner:{name:'Updated internal owner'},updatedAt:'2026-10-08T01:00:00Z'};
  f.streams.notes=[note('n',{updatedAt:'2026-10-08T02:00:00Z',updatedBy:{source:'MANUAL'},noteTargets:[{targetOpportunityId:'o'}]})];
  await f.runSync({full:true});
  assert.equal(f.state.transitions.length,2);
  assert.equal(f.state.opportunities.get('o').stageEnteredAt.getTime(),entered.getTime());
  assert.equal(f.state.transitions[0].changedAt.getTime(),before.getTime());
});

test('failed stage snapshot rolls back its transition, and retry logs the move once',async()=>{
  const f=fixture({opportunities:[opportunity('o',{stage:'PROPOSAL_SHARED'})]});
  f.state.opportunities.set('o',{opportunityId:'o',stage:'NEW_LEAD',data:opportunity('o',{stage:'NEW_LEAD'}),stageEnteredAt:before});
  f.state.failOpps.add('o');
  assert.equal((await f.runSync()).status,'partial');
  assert.equal(f.state.transitions.length,0);
  assert.equal(f.state.opportunities.get('o').stage,'NEW_LEAD');
  assert.equal(f.state.opportunities.get('o').stageEnteredAt.getTime(),before.getTime());
  f.state.failOpps.clear();
  await f.runSync();
  await f.runSync();
  assert.equal(f.state.transitions.length,1);
  assert.equal(f.state.opportunities.get('o').stage,'PROPOSAL_SHARED');
});


test('secondary assignee changes are retained even without an opportunity timestamp bump',async()=>{
  const f=fixture({opportunities:[opportunity('o',{secondaryAssignee:'TEAMMATE_A'})]});
  await f.runSync();
  const entered=f.state.opportunities.get('o').stageEnteredAt;
  f.streams.opportunities[0]={...f.streams.opportunities[0],secondaryAssignee:'TEAMMATE_B'};
  await f.runSync();
  assert.equal(f.state.opportunities.get('o').data.secondaryAssignee,'TEAMMATE_B');
  assert.equal(f.state.opportunities.get('o').stageEnteredAt.getTime(),entered.getTime());
  assert.equal(f.state.transitions.length,0);
});
