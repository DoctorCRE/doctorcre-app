import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFilters, activityRows, undoArgs } from '../js/doc-activity-model.js';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';
import { createLiveClient } from '../js/live-client.js';
import { carrInterface } from "./carr-contract.mjs";

test('activity filters have inclusive local calendar days and no caller identity', () => {
  const args = activityFilters({ partner:'joe', record_type:'deal', from:'2026-10-01', to:'2026-10-01' });
  assert.equal(args.partner,'joe'); assert.equal(args.record_type,'deal');
  assert.equal(Date.parse(args.until)-Date.parse(args.since),86_400_000);
  assert.equal(new Date(args.since).getHours(),0);
  assert.deepEqual(activityFilters(),{limit:50});
});
test('feed sorting, deduplication, schema refusal and exact undo identity', async () => {
  const fixture = createDocActivityFixture(() => new Date('2026-10-01T15:00:00Z'));
  const answer = await fixture.read(), first = answer.entries[0];
  const rows = activityRows({...answer,entries:[...answer.entries].reverse().concat(first)});
  assert.equal(rows.length,5); assert.equal(rows[0].id,first.id);
  assert.throws(()=>activityRows({...answer,schema_version:'future'}));
  assert.deepEqual(undoArgs(first,'key'),{event_id:first.id,idempotency_key:'key'});
  assert.equal(undoArgs({...first,undo:{...first.undo,event_id:'other'}},'key'),null);
  assert.equal(undoArgs(answer.entries[1],'key'),null);
});
test('fixture filters, keyset pagination and undo replay are in memory only', async () => {
  const fixture = createDocActivityFixture(()=>new Date('2026-10-01T15:00:00Z'));
  const page = await fixture.read({limit:1}); assert.ok(page.next_cursor);
  const next = await fixture.read({limit:1,cursor:page.next_cursor}); assert.notEqual(page.entries[0].id,next.entries[0].id);
  assert.equal((await fixture.read({partner:'dell'})).entries.length,2);
  assert.equal((await fixture.read({record_type:'lead'})).entries.length,1);
  const args = undoArgs(page.entries[0],'demo-key');
  const result = await fixture.undo(args); assert.deepEqual(await fixture.undo(args),result);
  assert.equal((await fixture.read()).entries[0].undo.state,'undone');
});
test('live read uses pinned scoped verb, cancellation and stable undo request', async () => {
  const calls=[]; const client=createLiveClient({fetchImpl:async(path,init)=>{
    calls.push({path,init,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({ok:true})}]}}));
  }});
  await client.readDocActivity({partner:'dell',limit:1});
  await client.revertDealField({event_id:'demo-event',idempotency_key:'demo-key'});
  assert.equal(calls[0].body.params.name,'read-doc-activity');
  assert.deepEqual(calls[0].body.params.arguments,{partner:'dell',limit:1}); assert.ok(calls[0].init.signal);
  assert.equal(calls[1].body.params.name,'revert-deal-field'); assert.equal(calls[1].body.params.arguments.idempotency_key,'demo-key');
  const contract=carrInterface;
  assert.ok(contract.mcp_operations.includes('read-doc-activity'));
});

test('malformed or partial feed rows are unavailable rather than verified empty; incompatible inverses cannot execute',async()=>{
  const answer=await createDocActivityFixture().read(),row=answer.entries[0];
  for(const broken of [{...row,id:null},{...row,record:{...row.record,name:null}},{...row,what:null},{...row,before:{}},{...row,undo:null},{...row,evidence:{kind:'entry',summary:[]}}]){
    assert.throws(()=>activityRows({...answer,entries:[broken]}),'a wholly malformed feed must not be empty success');
    assert.throws(()=>activityRows({...answer,entries:[row,broken]}),'a partial feed must not count as complete');
  }
  for(const response of [{...answer,as_of:'bad'},{...answer,next_cursor:{at:'bad',id:row.id}},{...answer,record_types:[null]}])assert.throws(()=>activityRows(response));
  assert.deepEqual(activityRows({...answer,entries:[]}),[]);
  for(const undo of [{...row.undo,verb:'future-verb'},{...row.undo,event_id:'other'}])assert.equal(undoArgs({...row,undo},'key'),null);
});

test('Doc activity registers its route, gate and deployed files alongside the main routes', async () => {
  const { routeContract: contract } = await import('../js/routes.js');
  assert.equal(contract.routes['/doc-activity'], 'activity.html');
  assert.equal(contract.gatePaths['/doc-activity'], '/control-room');
  for (const route of ['/deals', '/leads', '/relationships', '/invoices', '/control-room/progress']) assert.ok(contract.routes[route], `main route survives: ${route}`);
});

test('activity feed orders precise instants before using descending IDs and preserves source rows', async () => {
  const answer = await createDocActivityFixture().read();
  const row = answer.entries[0];
  const entries = [
    { ...row, id: 'z-old', at: '2026-10-26T12:00:00.000001Z' },
    { ...row, id: 'a-new', at: '2026-10-26T12:00:00.000002Z' },
    { ...row, id: 'b-new', at: '2026-10-26T07:00:00.000002-05:00' },
  ];
  const original = structuredClone(entries);
  assert.deepEqual(activityRows({ ...answer, entries }).map(item => item.id), ['b-new', 'a-new', 'z-old']);
  assert.deepEqual(entries, original);
  assert.throws(() => activityRows({ ...answer, entries: [{ ...row, at: null }] }), /activity_unavailable/);
});
