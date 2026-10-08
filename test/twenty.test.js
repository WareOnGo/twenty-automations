import test from 'node:test';
import assert from 'node:assert/strict';
import { listRecordsSince } from '../src/services/twenty.service.js';

process.env.TWENTY_CRM_BASE_URL='https://twenty.invalid';
process.env.TWENTY_CRM_API_KEY='test-only';
const record=id=>({id,updatedAt:'2026-10-08T00:00:00Z'});
const page=(records,hasNextPage=false,endCursor=null)=>({data:{notes:records},pageInfo:{hasNextPage,endCursor}});
const transport=pages=>async()=>({ok:true,json:async()=>pages.shift()});

test('follows cursors and preserves all fields',async()=>{
  const calls=[];
  const pages=[page([{...record('a'),bodyV2:{markdown:'full body'},newField:42}],true,'cursor1'),page([record('b')])];
  const fetchImpl=async(url)=>{calls.push(url);return {ok:true,json:async()=>pages.shift()};};
  const records=await listRecordsSince('notes',{fetchImpl,sinceISO:'2026-10-01T00:00:00Z'});
  assert.equal(records.length,2);
  assert.equal(records[0].newField,42);
  assert.equal(calls[1].searchParams.get('starting_after'),'cursor1');
  assert.equal(calls[0].searchParams.get('filter'),'updatedAt[gte]:2026-10-01T00:00:00Z');
});

for(const [name,pages] of [
  ['missing data',[{pageInfo:{hasNextPage:false}}]],
  ['missing page metadata',[{data:{notes:[]}}]],
  ['empty unfinished page',[page([],true,'cursor')]],
  ['missing cursor',[page([record('a')],true)]],
  ['repeated cursor',[page([record('a')],true,'same'),page([record('b')],true,'same')]],
  ['duplicate ID',[page([record('a')],true,'cursor'),page([record('a')])]],
  ['invalid timestamp',[page([{id:'a',updatedAt:'invalid'}])]],
]) test(`rejects ${name} instead of returning partial records`,async()=>{
  await assert.rejects(listRecordsSince('notes',{fetchImpl:transport(pages)}));
});

test('page cap is an error, not successful truncation',async()=>{
  await assert.rejects(listRecordsSince('notes',{fetchImpl:transport([page([record('a')],true,'cursor')]),maxPages:1}),/page limit/);
});

test('timeout includes stalled JSON body reads',async()=>{
  const fetchImpl=async(url,{signal})=>({ok:true,json:()=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('body timeout')),{once:true});
  })});
  await assert.rejects(listRecordsSince('notes',{fetchImpl,pageTimeoutMs:10}),/body timeout/);
});

test('HTTP failures never expose provider response bodies',async()=>{
  await assert.rejects(listRecordsSince('notes',{fetchImpl:async()=>({ok:false,status:502,json:async()=>({secret:'no'})})}),/HTTP 502/);
});
