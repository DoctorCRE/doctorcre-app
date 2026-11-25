import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocContext,normalizeDocRead,docAnswer} from '../js/doc-context-model.js';
const old='2026-10-01T10:00:00Z', newer='2026-10-01T11:00:00Z';
const party={id:'sample',name:'Sample',record_version:1,owner_label:'Quinn Sample',recorded_status:'active',recorded_status_label:'Active client',recorded_stage:'approved',recorded_stage_label:'Approved vendor'};
test('R7 timestamp and numeric-string revisions outrank old activity; equal revision enriches only',()=>{
 for(const [a,b] of [[old,newer],['9','10']]) {
  const c=createDocContext({page:'clients'});
  c.finish(c.begin('businessActivity',[{dataset:'clients',id:'sample'}]),{record:{...party,record_version:a},activities:[{what:'Old activity',when:old}]});
  c.finish(c.begin('businessRecord',[{dataset:'clients',id:'sample'}]),{record:{...party,record_version:b,name:'New facts'}});
  assert.equal(c.snapshot().records[0].title,'New facts');assert.deepEqual(c.snapshot().records[0].activity,[]);
 }

});
test('Leads workspace accepts doctor_name and base_version',()=>{
 const rows=normalizeDocRead('getWorkspace',{leads:[{id:'example-lead',doctor_name:'Sample lead',base_version:2}]});
 assert.equal(rows?.[0].title,'Sample lead');assert.equal(rows?.[0].version,2);
});
test('R11 Search context uses versioned results and ignores retired catch-up reads', () => {
 const c = createDocContext({page:'search'});
 const result = {id:'sample',kind:'company',name:'Sample',city:null,lead_id:null,roles:['client'],deals:[]};
 const payload = {schema_version:'search.v1',parties:[result],deals:[]};
 assert.equal(c.finish(c.begin('find'),payload),true);
 assert.equal(c.begin('findAndCatchUp'),null);
 assert.equal(c.snapshot().ready,true);
 assert.deepEqual(c.snapshot().records.map(({id,title}) => ({id,title})),[{id:'sample',title:'Sample'}]);

 assert.equal(c.finish(c.begin('find'),{...payload,parties:[]}),true);
 assert.equal(c.snapshot().ready,true);
 assert.deepEqual(c.snapshot().records,[]);
});
test('R12 directory list/detail/activity preserve recorded labels',()=>{
 for(const dataset of ['clients','vendors']) for(const method of ['businessList','businessRecord','businessActivity']) {
  const payload=method==='businessList'?{rows:[party]}:{record:party,activities:[{what:'New',when:newer},{what:'Old',when:old}]};
  const [row]=normalizeDocRead(method,payload,[{dataset,id:'sample'}]);
  assert.equal(row.fields.find(f=>f.label==='Owner').value,'Quinn');
  assert.equal(row.fields.find(f=>f.label==='Status').value,dataset==='clients'?'Active client':'Approved vendor');
  if(method==='businessActivity')assert.equal(row.activity[0].text,'New');
 }
});
test('R13 merged activity sorts descending and incomplete conversation cannot claim the latest entry',()=>{
 const c=createDocContext({page:'deals'});
 c.finish(c.begin('getDeal',['sample']),{deal:{id:'sample',name:'Sample'},activities:[{summary:'Old',occurred_at:old}],history:[{description:'New',recorded_at:newer}]});
 assert.equal(docAnswer(c.snapshot(),{recordId:'sample',question:'Recent activity'}).value,'New');
 const chat=createDocContext({page:'chats'});
 const payload={identity:{id:'sample',title:'Sample'},latest_sequence:9,more:true,turns:[{sequence:1,body:'Old',at:old},{sequence:2,body:'New',at:newer}]};
 chat.finish(chat.begin('readDocConversation',[{conversation_id:'sample'}]),payload);
 assert.equal(chat.snapshot().records[0].activity[0].text,'New');
 assert.equal(docAnswer(chat.snapshot(),{recordId:'sample',question:'Recent activity'}).state,'unknown');
 assert.equal(docAnswer(chat.snapshot(),{recordId:'sample',question:'Recent activity'}).value,null);
});
test('filter projections expose only explicitly projected sources and never renew observations',()=>{
 let now=1000;const c=createDocContext({page:'deals',now:()=>now});
 const board={deals:[{id:'sample',name:'Sample',version:1}]};
 c.finish(c.begin('getBoard'),board);
 c.finish(c.begin('getDeal',['sample']),{deal:board.deals[0],activities:[{summary:'Detail only',occurred_at:old}]});
 now=2000;c.filter({query:'none'});
 assert.equal(c.project('getBoard',{deals:[]}),true);
 assert.equal(c.snapshot().ready,true);assert.deepEqual(c.snapshot().records,[]);
 assert.equal(c.snapshot().observedAt,new Date(1000).toISOString());
 c.filter({query:'Sample'});assert.deepEqual(c.snapshot().records,[]);
 assert.equal(c.project('getBoard',board),true);
 assert.deepEqual(c.snapshot().records[0].activity,[]);
 assert.equal(c.snapshot().observedAt,new Date(1000).toISOString());
});
test('filter changes reject both successful and failed prior-query tickets',()=>{
 const c=createDocContext({page:'search'});
 const prior=c.begin('find',[{query:'old'}]);
 c.filter({query:'new'});
 assert.equal(c.finish(prior,{parties:[{ref:'old',name:'Old query'}]}),false);
 assert.deepEqual(c.snapshot().records,[]);assert.equal(c.snapshot().ready,false);
 c.finish(c.begin('find',[{query:'new'}]),{parties:[{ref:'new',name:'New query'}]});
 c.fail(prior,{status:503});
 assert.equal(c.snapshot().ready,true);assert.deepEqual(c.snapshot().records.map(r=>r.id),['new']);
});
test('pending unfiltered Leads collection survives local filters but needs an explicit current projection',()=>{
 let now=1000;const c=createDocContext({page:'leads',now:()=>now});
 const ticket=c.begin('getWorkspace');
 const board={leads:[{id:'sample',doctor_name:'Sample lead',base_version:1}]};
 now=2000;c.filter({search:'no matches'});
 assert.equal(c.finish(ticket,board),true);
 assert.deepEqual(c.snapshot().records,[]);assert.equal(c.snapshot().ready,false);
 now=3000;assert.equal(c.project('getWorkspace',{leads:[]}),true);
 assert.equal(c.snapshot().ready,true);assert.deepEqual(c.snapshot().records,[]);
 assert.equal(c.snapshot().observedAt,new Date(2000).toISOString());
 c.filter({search:''});assert.equal(c.project('getWorkspace',board),true);
 c.select('lead','sample');assert.equal(c.snapshot().active.title,'Sample lead');
 assert.equal(c.snapshot().observedAt,new Date(2000).toISOString());
});
test('retained collection tickets cannot recover after failure, supersession, authorization loss or navigation',()=>{
 const board={leads:[{id:'sample',doctor_name:'Sample lead',base_version:1}]};
 const failed=createDocContext({page:'leads'}),pending=failed.begin('getWorkspace');
 failed.filter({search:'none'});failed.fail(pending,{status:503});
 assert.equal(failed.project('getWorkspace',board),false);assert.equal(failed.snapshot().ready,false);
 assert.equal(failed.snapshot().state,'unavailable');
 for(const invalidate of [c=>c.begin('getWorkspace'),c=>c.clear(),c=>c.navigate('leads'),c=>c.fail(null,{status:401})]){
  const c=createDocContext({page:'leads'}),ticket=c.begin('getWorkspace');
  c.filter({search:'none'});invalidate(c);
  assert.equal(c.finish(ticket,board),false);assert.equal(c.project('getWorkspace',board),false);
 }
 const c=createDocContext({page:'leads'}),old=c.begin('getWorkspace');c.filter({search:'none'});
 c.finish(c.begin('getWorkspace'),board);c.fail(old,{status:503});
 assert.equal(c.snapshot().ready,true);assert.equal(c.snapshot().records[0].id,'sample');
});
test('projecting one source does not restore another or turn a failed source into a successful read',()=>{
 const c=createDocContext({page:'home'});
 c.finish(c.begin('getHomeAgenda'),{deals:[{id:'sample',name:'Sample'}]});
 c.fail(c.begin('getLeadBoard'),{status:503});
 c.filter({scope:'mine'});
 assert.equal(c.project('getHomeAgenda',{deals:[]}),true);
 assert.equal(c.project('getLeadBoard',{leads:[]}),false);
 assert.deepEqual(c.snapshot().records,[]);
 c.fail(c.begin('getHomeAgenda'),{status:503});c.filter({scope:'all'});
 assert.equal(c.project('getHomeAgenda',{deals:[]}),false);assert.equal(c.snapshot().ready,false);
});
test('R17 deleted mounting interface has no callers or fallback',async()=>{
 const {readdir}=await import('node:fs/promises');
 for(const file of await readdir(new URL('../js/',import.meta.url)))if(file.endsWith('.js')){
  const source=await readFile(new URL('../js/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/mountDocDock|docFab/,file);
 }
});
test('R1/R5/R14 cached projection cannot recover failure or renew its observed time',()=>{
 let now=1000;const c=createDocContext({page:'deals',now:()=>now});
 c.finish(c.begin('getBoard'),{deals:[{id:'sample',name:'Sample'}]});const at=c.snapshot().observedAt;
 now=2000;c.filter({query:'none'});assert.equal(c.project('getBoard',{deals:[]}),true);assert.equal(c.snapshot().observedAt,at);
 const ticket=c.begin('getBoard');c.fail(ticket);c.filter({query:''});
 assert.equal(c.project('getBoard',{deals:[{id:'sample',name:'Sample'}]}),false);assert.equal(c.snapshot().ready,false);
});
