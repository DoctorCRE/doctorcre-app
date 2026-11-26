import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as view from '../js/deal-timeline.js';
import { activityRows } from '../js/notifications-model.js';
import { activityState } from '../js/record-activity-model.js';
import { prepareDealDetail } from '../js/local-deals-model.js';
import { sourceTime } from '../js/email-source-line.js';
import { activityGroupLabel, activityItems, renderDealActivity } from '../src/ui/deal-activity.ts';
import { foldEmailBody } from '../src/ui/home/email-signature.ts';
import { businessDay } from '../js/business-date.js';
import { compareInstants, escapeText } from '../js/change-receipts.mjs';
import { emailSubject } from '../js/correspondence.js';
import { noteText } from '../js/pipeline-model.js';
const { countdown, renderCriticalDates, calendarDay, updateCountdowns } = view;
// Renderers read a detail that was prepared once, as the app does when it loads a deal.
const dealTimeline = (d, n) => view.dealTimeline(prepareDealDetail(d), n);
const renderDealTimeline = (d, n) => view.renderDealTimeline(prepareDealDetail(d), n);
const renderDealUpdates = (d, n) => view.renderDealUpdates(prepareDealDetail(d), n);
import { createLiveClient } from '../js/live-client.js';
import { carrInterface } from "./carr-contract.mjs";

const now = Date.parse('2026-10-04T17:00:00Z');
const detail = {deal:{id:'demo',phase:'Legal',phase_started_on:{research:'2026-09-20',legal:'2026-10-03'}},history:[
  {id:'p1',field:'phase',new_value:{phase:'research'},recorded_at:'2026-09-20T12:00:00Z'},
  {id:'p2',field:'phase',new_value:'legal',recorded_at:'2026-10-03T12:00:00Z'},
],lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3',free_rent_months:2},
critical_dates:[{id:'loi',kind:'loi_expiry',due_on:'2026-10-03',source:'Demo contract'}],
thread:[{id:'note',kind:'note',at:'2026-10-01',text:'Demo note. '+ 'Original. '.repeat(30)}],
activities:[{id:'mail',kind:'email',summary:'Demo negotiated allowance',detail:'Original demo email <script>data only</script>',occurred_at:'2026-10-02T12:00:00Z'}],
documents:[{id:'doc',note:'Demo revised lease',prepared_at:'2026-10-03T12:00:00Z'}]};
test('phases use recorded entries; lease dates are exact and no rent/option date is calculated',()=>{
 const view = dealTimeline(detail,now);
 assert.equal(view.phases.find(p=>p.slug==='legal').day,'2026-10-03');
 assert.equal(view.phases.find(p=>p.slug==='pending').day,null);
 assert.equal(view.dates.find(d=>d.kind==='lease_commencement').day,'2026-11-01');
 assert.equal(dealTimeline({...detail,lease:{...detail.lease,status:'superseded'}}).dates.some(d=>d.kind==='lease_commencement'),false);
 assert.equal(calendarDay('2026-02-30'),null);
});
test('conflicting contract dates remain visible; co-located originals survive; kind is never inferred from prose',()=>{
 const view=dealTimeline({...detail,critical_dates:[{kind:'lease_commencement',due_on:'2026-11-01',note:'Demo signed contract date',source:'Demo contract clause'}, {kind:'commencement',due_on:'2026-11-02'}, {label:'Rent start',due_on:'2026-11-30'}]},now);
 assert.deepEqual(view.dates.filter(d=>d.kind==='lease_commencement').map(d=>d.day),['2026-11-01','2026-11-02']);
 assert.match(view.dates.find(d=>d.day==='2026-11-01').original,/Demo signed contract date/);
 assert.match(view.dates.find(d=>d.day==='2026-11-01').original,/Demo clause 3/);
 const statuses=dealTimeline({...detail,critical_dates:[{kind:'loi_expiry',due_on:'2026-10-03',status:'cleared'},{kind:'loi_expiry',due_on:'2026-10-03',status:'open'}]},now);
 assert.equal(statuses.dates.filter(d=>d.kind==='loi_expiry').length,2);
});
test('other dates show each saved name when they share a day', () => {
  const critical_dates = ['Phase effective date', 'Permit review'].map(note => ({
    kind: 'other', due_on: '2026-10-04', note,
  }));
  const root = new JSDOM(renderCriticalDates({ ...detail, critical_dates }, now)).window.document;
  const names = [...root.querySelectorAll('.critical-date .date-open')].map(label => label.textContent);
  assert.deepEqual(names.filter(name => critical_dates.some(date => date.note === name)), ['Phase effective date', 'Permit review']);
});
test('countdowns cross midnight and distinguish deadlines, cleared dates and past commencement',()=>{
 assert.deepEqual(countdown({day:'2026-10-04',deadline:true},now),{state:'today',text:'Due today'});
 assert.deepEqual(countdown({day:'2026-10-05',deadline:true},now),{state:'soon',text:'in 1 day'});
 assert.equal(countdown({day:'2026-10-03',deadline:true},now).text,'1 day late');
 assert.equal(countdown({day:'2026-10-03'},now).text,'1 day ago');
 assert.equal(countdown({day:'2027-01-04',deadline:true},now).text,'in 3 months');
 assert.equal(countdown({day:'2026-10-03',status:'cleared'},now).text,'Cleared');
 const root=new JSDOM(renderCriticalDates(detail,now)).window.document;
 updateCountdowns(root,now+86400000);
 assert.equal(root.querySelector('[data-countdown="2026-10-03"]').textContent,'2 days late');
});
test('updates preserve escaped originals, author, exact date and newest-first order',()=>{
 const html=renderDealUpdates(detail);
 assert.match(html,/Original demo email &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 const root=new JSDOM(html).window.document;
 assert.equal(root.querySelectorAll('.deal-note').length,2);
 assert.equal(root.querySelector('.deal-note time').dateTime,'2026-10-02T12:00:00Z');
 assert.equal(new JSDOM(renderDealTimeline(detail)).window.document.querySelectorAll('.phase-rail').length,1);
});
test('the live adapter preserves the versioned lease and explicit absence behind getDeal',async()=>{
 const contract=carrInterface.mcp_read_contracts['get-deal-room'];
 assert.equal(contract.response.schema_version,'deal-timeline.v1');
 assert.match(contract.producer.source_commit,/^[a-f0-9]{40}$/);
 const calls=[];
 for(const lease of [detail.lease,null]) {
  const client=createLiveClient({fetchImpl:async(path,init)=>{
   calls.push({path,init});return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({deal_id:'demo',name:'Demo assignment',phase:'legal',schema_version:'deal-timeline.v1',lease})}]}}),{status:200});
  }});
  const value=await client.getDeal('demo');assert.deepEqual(value.lease,lease);assert.equal(value.schema_version,'deal-timeline.v1');
 }
 assert.ok(calls.every(c=>c.path==='/mcp' && c.init.credentials==='same-origin'));
 assert.deepEqual(JSON.parse(calls[0].init.body).params,{name:'get-deal-room',arguments:{deal:'demo'}});
});
test('summary-only activity does not offer a fabricated original',()=>{
 const html=renderDealUpdates({activities:[{id:'mail',kind:'email',summary:'Demo summary',occurred_at:'2026-10-02T12:00:00Z'}]});
 assert.doesNotMatch(html,/unavailable|Read full update/);
});

test('zero notes omit the entire Updates section',()=>{
 assert.equal(renderDealUpdates({thread:[],activities:[]}), '');
});

test('settled dates leave the row and raise no deadline alarm',()=>{
 for (const [status,state,text] of [['cleared','complete','Cleared'],['passed','past','Passed'],['open','overdue','1 day late'],['done',undefined,undefined],['dropped',undefined,undefined]]) {
  const value={deal:detail.deal,critical_dates:[{id:'loi',kind:'loi_expiry',due_on:'2026-10-03',status}]};
  if(state) assert.deepEqual(countdown(dealTimeline(value,now).dates[0],now),{state,text});
  const root=new JSDOM(renderCriticalDates(value,now,false,true)).window.document;
  updateCountdowns(root,now+86400000);
  assert.equal(root.querySelector('[data-date-id="loi"]')?.dataset.state,status==='open'?'overdue':undefined);
  if(status!=='open') assert.equal(root.querySelector('.critical-dates-empty').textContent,'No critical dates+ Add date');
 }
});
test('settled undated dates leave the row too',()=>{
 for (const status of ['cleared','done','dropped','passed','open']) {
  const value={deal:detail.deal,critical_dates:[{id:'undated',kind:'loi_expiry',due_on:null,status}]};
  const tile=new JSDOM(renderCriticalDates(value,now)).window.document.querySelector('[data-date-id="undated"]');
  assert.equal(Boolean(tile),status==='open',status);
 }
});
test('a proposed date keeps its count beside Confirm and turns amber within a week',()=>{
 const id='00000000-0000-4000-8000-0000000000d1';
 const value={deal:detail.deal,critical_dates:[{id,kind:'loi_expiry',due_on:'2026-10-09',status:'proposed'}]};
 const tile=new JSDOM(renderCriticalDates(value,now,true)).window.document.querySelector(`[data-date-id="${id}"]`);
 assert.equal(tile.querySelector('[data-countdown]').textContent,'in 5 days');
 assert.equal(tile.dataset.state,'soon');
 assert.equal(tile.querySelector('.date-confirm').textContent,'Confirm');
});
test('review 2: recorded and projected lease expiration share urgency while commencement stays a milestone',()=>{
 for(const day of ['2026-10-03','2026-10-07']) {
  const expected=day==='2026-10-03'?'overdue':'soon';
  for(const lease of [null,{...detail.lease,expiration_on:day}]) {
   const value={deal:detail.deal,lease,critical_dates:lease?[]:[{id:'expiry',kind:'lease_expiration',due_on:day,status:'open'}]};
   const date=dealTimeline(value,now).dates.find(d=>d.kind==='lease_expiration');
   assert.equal(countdown(date,now).state,expected);
   const root=new JSDOM(renderCriticalDates(value,now)).window.document;
   assert.equal(root.querySelector(`[data-countdown="${day}"]`).closest('article').dataset.state,expected);
  }
  const date=dealTimeline({deal:detail.deal,critical_dates:[{kind:'lease_commencement',due_on:day,status:'open'}]},now).dates[0];
  assert.equal(countdown(date,now).state,day==='2026-10-03'?'past':'upcoming');
 }
});

test('updates show the latest excerpt and expand into recorded history',()=>{
 const root=new JSDOM(renderDealUpdates(detail)).window.document;
 const overview=root.querySelector('.updates-history > summary');
 assert.ok(overview);
 assert.match(overview.textContent,/Demo negotiated allowance/);
 assert.doesNotMatch(overview.textContent,/Demo note/);
 assert.ok(overview.textContent.length<400);
 const history=root.querySelector('.updates-history');
 assert.equal(history.open,false);
 assert.match(history.querySelector('summary').textContent,/2 updates/);
 assert.match(history.textContent,/Original demo email <script>data only<\/script>/);
 assert.equal(root.querySelectorAll('.deal-note').length,2);
});

test('timeline consumes first phase dates from the board projection and never overwrites them with a later revisit',()=>{
 const value={...detail,deal:{...detail.deal,phase_started_on:{research:'2026-08-31',legal:'2026-09-30'}},history:[...detail.history,{field:'phase',new_value:'research',recorded_at:'2026-10-04T12:00:00Z'}]};
 const phases=dealTimeline(value,now).phases;
 assert.equal(phases.find(p=>p.slug==='research').day,'2026-08-31');
 assert.equal(phases.find(p=>p.slug==='legal').day,'2026-09-30');
 assert.doesNotMatch(renderDealTimeline(value,now),/Start date not recorded/);
});

test('the live adapter preserves authoritative start dates in both board and detail reads',async()=>{
 const phase_started_on={research:'2026-08-31',legal:'2026-09-30'};
 const client=createLiveClient({fetchImpl:async(_path,init)=>{
  const {name}=JSON.parse(init.body).params;
  const result=name==='deal-room-board'?{deals:[{id:'demo',phase:'legal',next_step:'Review the draft',phase_started_on}]}:{deal_id:'demo',phase:'legal',next_step:'Review the draft',phase_started_on};
  return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(result)}]}}));
 }});
 assert.deepEqual((await client.getBoard()).deals[0].phase_started_on,phase_started_on);
 const detail=await client.getDeal('demo');
 assert.deepEqual(detail.deal.phase_started_on,phase_started_on);
 assert.equal(dealTimeline(detail).phases.find(p=>p.slug==='legal').day,'2026-09-30');
});


test('history includes all activities and discloses the source limit',()=>{
 const allActivities=Array.from({length:51},(_,i)=>({id:`activity-${i}`,kind:'note',summary:`Demo activity ${i}`,occurred_at:new Date(Date.UTC(2026,9,20,12,0,-i)).toISOString()}));
 const root=new JSDOM(renderDealUpdates({activities:allActivities})).window.document;
 assert.equal(root.querySelectorAll('.deal-note').length,51);
 assert.doesNotMatch(root.body.textContent,/Full history/i);
 assert.match(root.querySelector('.updates-history > summary').textContent,/51 updates/);
 assert.match(root.body.textContent,/latest 50 activities/i);
});

test('held task history names the hold date and retains the recorded action', () => {
 const task = { id:'synthetic-held', owner:'joe', status:'open', description:'Review synthetic terms <draft>', due_on:'2026-10-01', hold_until:'2027-01-01', updated_at:'2026-10-01T12:00:00Z' };
 const root = new JSDOM(renderDealUpdates({ thread:[], activities:[], next_actions:[task] }, now)).window.document;
 const row = root.querySelector('[data-id="action:synthetic-held"]');
 assert.ok(row, 'held tasks remain visible in deal history');
 assert.match(row.textContent, /Held until Jan 1, 2027/);
 assert.match(row.textContent, /Review synthetic terms <draft>/);
 assert.equal(row.querySelector('draft'), null);
 assert.equal(task.status, 'open');
 const released = new JSDOM(renderDealUpdates({next_actions:[{...task,hold_until:'2026-10-04'}]}, now)).window.document;
 assert.doesNotMatch(released.body.textContent, /Held until/);
});

test('Updates preview and Recorded updates use precise newest-first instants with undated notes last', () => {
 const value = {thread:[
  {id:'undated',text:'Synthetic undated update'},
  {id:'older',at:'2026-10-26T12:00:00.000001Z',text:'Synthetic older update'},
  {id:'newer',at:'2026-10-26T07:00:00.000002-05:00',text:'Synthetic latest update'},
  {id:'invalid',at:'unknown',text:'Synthetic invalid date'},
  {id:'historic',at:'1969-12-31T12:00:00Z',text:'Synthetic historic update'},
 ]};
 const root = new JSDOM(renderDealUpdates(value)).window.document;
 assert.match(root.querySelector('.updates-history > summary').textContent,/Synthetic latest update/);
 assert.deepEqual([...root.querySelectorAll('.deal-note')].map(row=>row.dataset.id),['newer','older','historic','undated','invalid']);
 assert.deepEqual(value.thread.map(row=>row.id),['undated','older','newer','invalid','historic']);
});

test('deal room activity includes documents in newest-first order without guessing undated positions', () => {
 const value = {...detail,thread:[{id:'undated',text:'Synthetic undated note'}],activities:[
  {id:'morning',summary:'Synthetic morning call',occurred_at:'2026-10-26T08:00:00-05:00'},
  {id:'afternoon',summary:'Synthetic afternoon email',occurred_at:'2026-10-26T20:00:00Z'},
 ],documents:[{id:'lease',note:'Synthetic revised lease',prepared_at:'2026-10-26T21:00:00Z'}]};
 assert.deepEqual(dealTimeline(value).entries.map(row=>row.id),['document-lease','afternoon','morning','undated']);
});

test('a null update timestamp stays explicitly unrecorded instead of showing the epoch', () => {
 const root=new JSDOM(renderDealUpdates({thread:[{id:'null-date',text:'Synthetic undated update',recorded_at:null}]})).window.document;
 assert.equal(root.querySelector('.deal-note time').textContent,'Date not recorded');
});

test('prepareDealDetail orders every dated list once and leaves its input untouched', () => {
 const value = {thread:[{id:'old',at:'2026-10-01T12:00:00Z',text:'Synthetic old'},{id:'new',at:'2026-10-02T12:00:00Z',text:'Synthetic new'}],
  activities:[{id:'a1',summary:'Synthetic first',occurred_at:'2026-10-01T09:00:00Z'},{id:'a2',summary:'Synthetic second',occurred_at:'2026-10-03T09:00:00Z'}],
  documents:[{id:'d',note:'Synthetic document',prepared_at:'2026-10-02T18:00:00Z'}]};
 const before = structuredClone(value);
 const ready = prepareDealDetail(value);
 assert.deepEqual(ready.thread.map(r=>r.id),['new','old']);
 assert.deepEqual(ready.activities.map(r=>r.id),['a2','a1']);
 assert.deepEqual(ready.entries.map(r=>r.id),['a2','document-d','new','old','a1']);
 assert.deepEqual(value,before);
});

test('rows with equal instants keep the order they arrived in', () => {
 for (const ids of [['a','z'],['z','a']]) {
  const ready = prepareDealDetail({thread:ids.map(id=>({id,at:'2026-10-02T12:00:00Z',text:`Synthetic ${id}`}))});
  assert.deepEqual(ready.thread.map(r=>r.id),ids);
 }
});

test('recorded instants display in Central time with the zone named', () => {
 assert.equal(sourceTime('2026-10-01T12:00:00Z', new Date('2026-10-30T12:00:00Z')),'Oct 1, 7:00 AM');
 assert.equal(sourceTime('2026-12-01T12:00:00Z', new Date('2027-01-01T12:00:00Z')),'Dec 1, 2026, 6:00 AM');
 assert.equal(sourceTime(null),'Time unavailable');
 const html = renderDealUpdates({thread:[{id:'n',at:'2026-10-01T12:00:00Z',text:'Synthetic note'}]});
 assert.match(new JSDOM(html).window.document.querySelector('.deal-note time').textContent,/7:00 AM$/);
});

test('recorded LOI evidence survives a missing due date without claiming the kind is absent', () => {
 const value={deal:detail.deal,critical_dates:[{id:'undated-loi',kind:'loi_expiry',due_on:null,note:'Synthetic LOI requires confirmation',source:'Synthetic clause 4',status:'open'}]};
 const root=new JSDOM(renderCriticalDates(value,now)).window.document;
 const row=root.querySelector('[data-date-id="undated-loi"]');
 assert.ok(row,'recorded undated LOI evidence remains readable');
 assert.match(row.textContent,/Date not recorded/);
 assert.equal(row.querySelector('small').textContent,'Status: open');
 assert.match(row.querySelector('.date-source').textContent,/Source: Synthetic clause 4/);
 assert.match(row.textContent,/Synthetic LOI requires confirmation/);
 assert.match(row.textContent,/Synthetic clause 4/);
 assert.equal(row.querySelector('[data-countdown]'),null);
});

test('undated originals keep their identities, status and evidence alongside conflicting dated entries', () => {
 const value={deal:detail.deal,lease:{id:'blank',status:'current'},critical_dates:[
  {id:'missing',kind:'loi_expiry',due_on:null,note:'Synthetic original <draft>',source:'Synthetic source A',status:'cleared'},
  {id:'invalid',kind:'loi_expiry',due_on:'2026-02-30',note:'Synthetic impossible date',source:'Synthetic source B',status:'passed'},
  {id:'unknown',kind:'custom_notice',label:'Synthetic custom requirement',date:'bad',due_on:'bad',note:'Synthetic custom requirement'},
  {id:'second-missing',kind:'loi_expiry',due_on:null,note:'Synthetic second original'},
  {id:'dated',kind:'loi_expiry',due_on:'2026-10-05',note:'Synthetic dated original'},
  {id:'conflict',kind:'loi_expiry',due_on:'2026-10-06',note:'Synthetic conflicting original'},
 ]};
 const before=structuredClone(value);
 const model=dealTimeline(value,now);
 assert.deepEqual(model.dates.map(d=>d.day),['2026-10-05','2026-10-06']);
 assert.deepEqual(model.undated.map(d=>[d.id,d.dateState,d.status]),[['missing','missing','cleared'],['invalid','invalid','passed'],['unknown','invalid',undefined],['second-missing','missing',undefined]]);
 assert.equal(model.undated.some(d=>d.kind==='lease_commencement'),false);
 const root=new JSDOM(renderCriticalDates(value,now)).window.document;
 assert.equal(root.querySelectorAll('[data-countdown]').length,2);
 for (const row of value.critical_dates.filter(row=>!row.status)) {
  const card=root.querySelector(`[data-date-id="${row.id}"]`);
  assert.match(card.textContent,new RegExp(row.note.replace(/[<>]/g,'.')));
  if(row.source) assert.ok(card.textContent.includes(row.source));
 }
 assert.equal(root.querySelector('[data-date-id="unknown"] .date-open').textContent,'Custom notice');
 assert.match(root.querySelector('[data-date-id="unknown"]').textContent,/Date unavailable/);
 assert.equal(root.querySelector('[data-date-id="missing"]'),null,'a cleared undated date leaves the row');
 assert.equal(root.querySelector('[data-date-id="invalid"]'),null,'a passed undated date leaves the row');
 const undatedBefore=[...root.querySelectorAll('[data-state="unknown"]')].map(n=>n.outerHTML);
 updateCountdowns(root,now+86400000);
 assert.deepEqual([...root.querySelectorAll('[data-state="unknown"]')].map(n=>n.outerHTML),undatedBefore);
 assert.equal(root.querySelector('[data-date-id="dated"] strong').textContent,'Due today');
 assert.deepEqual(value,before);
});

test('Central day controls countdown and hold expiry regardless of host timezone', () => {
 const instant = Date.parse('2026-11-06T02:00:00Z');
 assert.deepEqual(countdown({day:'2026-11-05',deadline:true},instant),{state:'today',text:'Due today'});
 const held = {deal:{phase:'Legal'},entries:[{id:'hold',source:'hold',holdUntil:'2026-11-06',when:'2026-11-05',summary:'Synthetic hold'}]};
 assert.match(view.renderDealUpdates(held,instant), /Synthetic hold/);
 assert.equal(view.renderDealUpdates(held,Date.parse('2026-11-06T06:00:00Z')), '');
});

test('Central disposition chart preserves precedence and calendar arithmetic', () => {
 const instant = Date.parse('2026-11-06T02:00:00Z');
 for (const [date,state,text] of [
  [{day:'2026-02-30',status:'cleared'},'unknown','—'],
  [{day:null,status:'passed'},'unknown','—'],
  [{day:'2026-11-04',status:'cleared',deadline:true},'complete','Cleared'],
  [{day:'2026-11-06',status:'passed',deadline:true},'past','Passed'],
  [{day:'2026-11-04',deadline:true},'overdue','1 day late'],
  [{day:'2026-11-04'},'past','1 day ago'],
  [{day:'2026-11-05',deadline:true},'today','Due today'],
  [{day:'2026-11-05'},'today','Today'],
  [{day:'2026-11-12',deadline:true},'soon','in 7 days'],
  [{day:'2026-11-13',deadline:true},'upcoming','in 8 days'],
  [{day:'2026-11-06'},'upcoming','in 1 day'],
 ]) assert.deepEqual(countdown(date,instant),{state,text});
 for (const [at,day] of [
  ['2026-03-08T07:59:59Z','2026-03-08'],['2026-03-08T08:00:00Z','2026-03-08'],
  ['2026-11-01T06:59:59Z','2026-11-01'],['2026-11-01T07:00:00Z','2026-11-01'],
 ]) assert.equal(countdown({day,deadline:true},Date.parse(at)).text,'Due today');
 const date={day:'2026-11-06',deadline:true};
 for (const [at,text] of [['2026-10-29T17:00:00Z','in 8 days'],['2026-10-30T17:00:00Z','in 7 days'],['2026-11-06T05:59:59Z','in 1 day'],['2026-11-06T06:00:00Z','Due today'],['2026-11-07T06:00:00Z','1 day late']]) assert.equal(countdown(date,Date.parse(at)).text,text);
});

test('registered Deal Room response passes production parser without shifting dates or evidence', async () => {
 const contract=carrInterface.mcp_read_contracts['get-deal-room'];
 const payload={deal_id:'synthetic-central',name:'Synthetic deadline',phase:'legal',schema_version:contract.response.schema_version,
 phase_started_on:{legal:'2026-10-03'},critical_dates:[{id:'synthetic-date',kind:'loi_expiry',due_on:'2026-11-05',status:'open',source:'Synthetic contract clause'}],lease:null,thread:[],events:[]};
 assert.equal(payload.schema_version,'deal-timeline.v1');
 assert.ok(carrInterface.mcp_operations.includes('get-deal-room'));
 const before=structuredClone(payload);
 const client=createLiveClient({fetchImpl:async (_path,init)=>{
  assert.equal(JSON.parse(init.body).params.name,'get-deal-room');
  return Response.json({result:{content:[{type:'text',text:JSON.stringify(payload)}]}});
 }});
 const detail=prepareDealDetail(await client.getDeal(payload.deal_id));
 const instant=Date.parse('2026-11-06T02:00:00Z');
 const root=new JSDOM(renderCriticalDates(detail,instant)).window.document;
 assert.equal(root.querySelector('[data-countdown]').textContent,'Due today');
 assert.equal(root.querySelector('[data-countdown]').dataset.countdown,'2026-11-05');
 assert.match(root.body.textContent,/Synthetic contract clause/);
 assert.equal(view.dealTimeline(detail,instant).phases.find(p=>p.slug==='legal').day,'2026-10-03');
 assert.deepEqual(payload,before);
});

test('countdown DOM follows upcoming to soon to today to overdue on Central days', () => {
 const value={deal:{phase:'legal'},critical_dates:[{id:'transition',kind:'loi_expiry',due_on:'2026-11-06'}]};
 const root=new JSDOM(renderCriticalDates(value,Date.parse('2026-10-29T17:00:00Z'))).window.document;
 for(const [at,state,text] of [
  ['2026-10-29T17:00:00Z','upcoming','in 8 days'],
  ['2026-10-30T17:00:00Z','soon','in 7 days'],
  ['2026-11-06T05:59:59Z','soon','in 1 day'],
  ['2026-11-06T06:00:00Z','today','Due today'],
  ['2026-11-07T06:00:00Z','overdue','1 day late'],
 ]) {
  updateCountdowns(root,Date.parse(at));
  assert.equal(root.querySelector('.critical-date').dataset.state,state);
  assert.equal(root.querySelector('[data-countdown]').textContent,text);
 }
});

test('old deal history labels authors and facts in the words used on the deal page', () => {
 const cases = [
  ['update-deal', 'outcome', { outcome: 'lost' }, 'Outcome: Lost'],
  ['update-deal', 'notes_path', { notes_path: '/example/old-notes.md' }, 'Updated where the deal notes are kept'],
  ['reattach-deal', 'client_id', { client_name: 'Example Practice', client_ref: 'C-123' }, 'Client: Example Practice'],
  ['new-deal', null, { name: 'Example deal', client: 'C-456' }, 'Deal name: Example deal'],
  ['new-deal', null, { reason: 'additional_office' }, 'Deal reason: Additional office'],
  ['dismiss-email-proposal', null, { reason: 'Already handled' }, 'Reason: Already handled'],
  ['add-critical-date', null, { kind: 'lease_end' }, 'Date type: Lease expiration'],
  ['log-activity', null, { kind: 'email_out' }, 'Activity type: Email sent'],
  ['dismiss-email-proposal', null, { kind: 'file_to_deal' }, 'Suggestion type: File email to this deal'],
  ['record-finding', 'address', { found: false }, 'Result: Nothing found'],
  ['add-premises', null, { ownership: 2 }, 'Owners listed: 2'],
  ['set-next-action', null, { set_by: 'mail_capture' }, 'Set by: Mail filing'],
 ];
 for (const [verb, field, new_value, expected] of cases) {
  const html = view.renderImportedDealHistory([{ verb, field, new_value, imported: true,
    actor: 'mail_capture', recorded_at: '2025-01-06T00:00:00Z' }]);
  const row = new JSDOM(html).window.document.querySelector('li');
  assert.equal(row.querySelector('b').textContent, 'Mail filing');
  assert.ok(row.textContent.includes(expected), expected);
  assert.doesNotMatch(row.textContent, /C-123|C-456|old-notes\.md/);
 }
});

test('old deal history names partner owners and leaves out owners with no name', () => {
 const facts = new_value => new JSDOM(view.renderImportedDealHistory([{ verb: 'set-lead', field: null, new_value,
  imported: true, actor: 'joe', recorded_at: '2025-01-06T00:00:00Z' }])).window.document.querySelector('li').textContent;
 assert.match(facts({ lead: 'dell-local' }), /Deal owner: Dell/);
 assert.match(facts({ lead: 'joe-local', owner: 'dell' }), /Deal owner: Joe[\s\S]*Assigned to: Dell/);
 for (const slug of ['claude', 'codex', 'constructor']) {
  const text = facts({ lead: slug, assignee: 'dell' });
  assert.doesNotMatch(text, /unavailable|Deal owner:/i, slug);
  assert.match(text, /Changed the deal owner[\s\S]*Assigned to: Dell/, slug);
 }
});

test('old deal history keeps the named side of an owner change', () => {
 const row = (event) => new JSDOM(view.renderImportedDealHistory([{ verb: 'set-lead', field: null, imported: true,
  recorded_at: '2025-01-06T00:00:00Z', ...event }])).window.document.querySelector('li');
 assert.match(row({ actor: 'joe', old_value: { lead: 'claude' }, new_value: { lead: 'dell' } }).textContent, /Deal owner: Dell/);
 assert.doesNotMatch(row({ actor: 'joe', old_value: { lead: 'dell' }, new_value: { lead: 'claude' } }).textContent, /Deal owner/);
});

test('a partner machine sign-in names the partner as an owner and reads as the automation as an author', () => {
 for (const [slug, name] of [['dell-local', 'Dell'], ['joe-local', 'Joe']]) {
  const row = new JSDOM(view.renderImportedDealHistory([{ verb: 'set-lead', field: null, imported: true, actor: slug,
   new_value: { lead: slug }, recorded_at: '2025-01-06T00:00:00Z' }])).window.document.querySelector('li');
  assert.equal(row.querySelector('b').textContent, 'Automatically', slug);
  assert.match(row.textContent, new RegExp(`Deal owner: ${name}`), slug);
  assert.equal(activityRows([{ actor: slug, verb: 'set-next-step', subject_type: 'lead', subject_id: 'l1', recorded_at: '2026-01-14T14:22:00Z' }])[0].actor,
   'Recorded actor', slug);
  const answer = { state: 'completed', match: { target: 'V-1' }, catch_up: { timeline: [{ actor: slug, occurred_at: '2026-09-18T15:30:00.000Z', verb: 'log-call' }] } };
  assert.equal(activityState({ ref: 'V-1' }, answer).rows[0].actor, null, slug);
 }
});

const activityPorts = {
  businessDay, compareInstants, escapeText, emailSubject, calendarDay: view.calendarDay, changeText: view.changeText,
  dateCaption: view.dateCaption, importedHistoryEntries: view.importedHistoryEntries, timelineActor: view.timelineActor, sourceTime, noteText,
};
const activityNow = new Date('2026-11-18T15:00:00Z');
const activityQuote = 'The lease is signed.\n\nPat Example\nExample Realty Group\n555-010-0100 (o)\nexamplerealty.com\n\nFrom: Sam Example\nSent: Monday\nTo: Pat Example\nSubject: Lease\n\nIs it signed?';

function activitySample() {
  return {
    thread: [
      { id: 'copied-note', kind: 'note', text: 'Tour plans confirmed', actor: 'dell', created_at: '2026-11-17T20:00:00Z' },
      { id: 'older-note', kind: 'note', text: 'Recorded next step', actor: 'joe', created_at: '2025-01-03T10:00:00.000002Z' },
      { id: 'undated-note', kind: 'note', text: 'Note without a time', actor: 'joe' },
    ],
    correspondence: [
      { kind: 'email', activity_id: 'mail-1', subject: 'Example suite floor plan', sender_name: 'Example Broker', happened_at: '2026-11-17T21:00:00Z' },
      { kind: 'meeting', activity_id: 'meet-1', title: 'Property tour', happened_at: '2026-11-16T18:00:00Z' },
    ],
    activities: [
      { id: 'mail-1', kind: 'email', summary: activityQuote, occurred_at: '2026-11-17T21:00:00Z', actor: 'mail_capture' },
      { id: 'raw-mail', kind: 'email', summary: activityQuote, sender: 'Pat Example', occurred_at: '2026-10-02T15:00:00Z', actor: 'agent' },
      { id: 'empty-call', kind: 'call', summary: ' ', occurred_at: '2026-11-16T13:00:00Z' },
      { id: 'call-1', kind: 'call', summary: 'Called the landlord', occurred_at: '2026-11-15T16:00:00Z', actor: 'joe' },
    ],
    documents: [{ id: 'file', name: 'Example plan.pdf', actor: 'mail_capture', prepared_at: '2026-11-16T14:00:00Z' }],
    next_actions: [
      { id: 'step', description: 'Check the floor plan', status: 'open', actor: 'joe', updated_at: '2026-11-17T18:00:00Z' },
      { id: 'done-step', description: 'Send the sample plan', status: 'done', actor: 'joe', updated_at: '2026-11-17T18:30:00Z', due_on: '2026-11-24' },
    ],
    critical_dates: [{ id: 'due', kind: 'due_diligence', status: 'open', due_on: '2026-11-19', actor: 'dell', updated_at: '2026-11-17T19:00:00Z' }],
    history: [
      { id: 'copied-event', activity_id: 'copied-note', field: 'note', new_value: 'Tour plans confirmed', actor: 'dell', recorded_at: '2026-11-17T20:00:01Z' },
      { id: 'move', verb: 'move-phase', field: 'phase', new_value: 'legal', actor: 'agent', recorded_at: '2026-11-18T01:00:00Z' },
      { id: 'same-file', verb: 'prepare-document', field: 'document', new_value: { name: 'Example plan.pdf' }, actor: 'joe', recorded_at: '2026-11-16T14:00:01Z' },
    ],
    imported_deal_history: [
      { id: 'old-1', imported: true, actor: 'joe', verb: 'new-deal', field: null, new_value: { deal_type: 'lease', reason: 'Renewal' }, recorded_at: '2025-01-06T00:00:00Z' },
    ],
    email_follow_ups: [],
  };
}

test('one activity list keeps each thing once and leaves next steps on Overview', () => {
  const items = activityItems(activitySample(), { now: activityNow, fold: foldEmailBody, ports: activityPorts });
  const titles = items.map(item => item.title);
  assert.equal(titles.filter(title => title === 'Example suite floor plan').length, 1);
  assert.equal(titles.filter(title => title === 'Example plan.pdf').length, 1);
  assert.equal(titles.filter(title => title === 'Tour plans confirmed').length, 1);
  assert.equal(titles.includes('Check the floor plan'), false);
  assert.equal(titles.includes('Send the sample plan · Done · Due Nov 24, 2026'), true);
  assert.equal(items.at(-1).title, 'Note without a time');
  assert.equal(items.at(-1).caption, 'Date not recorded');
  assert.equal(titles.some(title => title.startsWith('Due diligence')), false);
  assert.equal(titles.includes('Called the landlord'), true);
  const folded = items.find(item => item.id === 'raw-mail');
  assert.equal(folded.title, 'The lease is signed. Pat Example');
  assert.equal(folded.title.includes('555-010-0100'), false);
  assert.equal(folded.who, 'Pat Example');
  assert.equal(items.find(item => item.id === 'file').who, 'Mail filing');
  assert.equal(items.find(item => item.id === 'move').title, 'Moved to Legal');
  assert.equal(items.find(item => item.id === 'move').who, 'Written by the assistant');
  assert.equal(items[0].id, 'move');
  assert.deepEqual(items.map(item => activityGroupLabel(item.day, activityNow, activityPorts)).filter((label, index, all) => all.indexOf(label) === index), [
    'This week', 'Earlier in November', 'October', 'January 2025', 'Date not recorded',
  ]);
});

test('an empty engine read says nothing is recorded and a failed correspondence read does not', () => {
  const empty = renderDealActivity({ email_follow_ups: [], correspondence: [], thread: [] }, { now: activityNow, ports: activityPorts });
  const failed = renderDealActivity({ email_follow_ups: [], thread: [] }, { now: activityNow, ports: activityPorts });
  assert.match(empty.html, /Nothing recorded yet\./);
  assert.doesNotMatch(empty.html, /Dated events|Correspondence/);
  assert.match(failed.html, /Emails and meetings unavailable\./);
  assert.doesNotMatch(failed.html, /Nothing recorded yet\./);
  const waiting = renderDealActivity({
    email_follow_ups: [{ kind: 'file_to_deal' }, { kind: 'file_to_deal' }], correspondence: [], thread: [],
  }, { now: activityNow, ports: activityPorts });
  assert.match(waiting.html, /2 emails are waiting to be filed on Overview\./);
  assert.match(empty.html, /id="activityNote" name="text" rows="1" maxlength="10000" placeholder="Add a note"/);
  assert.ok(empty.html.indexOf('id="activityNoteForm"') < empty.html.indexOf('aria-label="Activity filter"'));
  assert.doesNotMatch(empty.html, /class="activity-row"[^>]*>[\s\S]*<button/);
});

test('activity-only emails show sender_name or sender before the filing actor', () => {
  const items = activityItems({
    correspondence: [],
    activities: [
      {
        id: 'named-mail', kind: 'email', summary: 'Sent the revised LOI',
        sender_name: 'Pat Example', sender: 'pat@example.com', actor: 'joe', occurred_at: '2026-11-17T18:00:00Z',
      },
      {
        id: 'address-mail', kind: 'email', summary: 'Follow-up on tenant allowance',
        sender: 'sam@example.com', actor: 'joe', occurred_at: '2026-11-17T17:00:00Z',
      },
      {
        id: 'actor-only-mail', kind: 'email', summary: 'Filed without sender metadata',
        actor: 'joe', occurred_at: '2026-11-17T16:00:00Z',
      },
    ],
  }, { now: activityNow, fold: foldEmailBody, ports: activityPorts });
  assert.equal(items.find(item => item.id === 'named-mail').who, 'Pat Example');
  assert.equal(items.find(item => item.id === 'address-mail').who, 'sam@example.com');
  assert.equal(items.find(item => item.id === 'actor-only-mail').who, 'Joe');
});

test('refreshing Activity keeps an empty chosen filter and shows its empty line', () => {
  const detail = {
    correspondence: [
      { kind: 'email', activity_id: 'mail-1', subject: 'Example suite floor plan', sender_name: 'Example Broker', happened_at: '2026-11-17T21:00:00Z' },
    ],
    imported_deal_history: [
      { id: 'old-1', imported: true, actor: 'joe', verb: 'new-deal', field: null, new_value: { deal_type: 'lease', reason: 'Renewal' }, recorded_at: '2025-01-06T00:00:00Z' },
    ],
    email_follow_ups: [],
  };
  const rendered = renderDealActivity(detail, { now: activityNow, filter: 'documents', ports: activityPorts });
  assert.equal(rendered.filter, 'documents');
  const doc = new JSDOM(rendered.html).window.document;
  assert.equal(doc.querySelector('[data-activity-filter="documents"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-activity-filter="all"]').getAttribute('aria-pressed'), 'false');
  assert.ok([...doc.querySelectorAll('[data-activity-group]')].every(group => group.hidden));
  const empty = doc.querySelector('.activity-empty');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'No documents.');

  const emailsOnly = renderDealActivity(detail, { now: activityNow, filter: 'emails', ports: activityPorts });
  const emailsDoc = new JSDOM(emailsOnly.html).window.document;
  assert.deepEqual(
    [...emailsDoc.querySelectorAll('[data-activity-group]:not([hidden]) h3')].map(heading => heading.textContent),
    ['This week'],
  );
  assert.equal(emailsDoc.querySelector('.activity-empty').hidden, true);

  const fallback = renderDealActivity(detail, { now: activityNow, filter: 'unknown', ports: activityPorts });
  assert.equal(fallback.filter, 'all');
});
