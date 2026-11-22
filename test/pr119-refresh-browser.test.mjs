import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, settles, waitForAsync, returnToTab } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { createFixtureClient } from '../js/fixture-client.js';
let server, origin;
before(async()=>{
 server=await fixtureServer();origin=server.origin;
});
after(()=>server?.close());
async function open(t,{smallChats=false,clientHooks=''}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/{api/system-work/session,auth/session}',r=>r.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic'}}));
 if(smallChats || clientHooks)await page.route('**/js/fixture-client.js',async r=>{
  let src=await readFile(new URL('../js/fixture-client.js',import.meta.url),'utf8');src=src.replace('export async function createFixtureClient','async function originalFixture');
  src+=`\nexport async function createFixtureClient(opts){const c=await originalFixture(opts);${smallChats ? "for(const name of ['listDocConversations','readDocConversation']){const f=c[name];c[name]=args=>f({...args,limit:1});}" : ''}${clientHooks}return c;}`;
  await r.fulfill({contentType:'text/javascript',body:src});
 });
 return {page,errors};
}
const online=page=>page.evaluate(()=>window.dispatchEvent(new Event('online')));
test('PR119 finding 8: loaded Doc Chats traversal expires as a whole and can recover',async t=>{
 const hooks=`const read=c.listDocConversations;
 window.chatResponses=[];window.chatReadCount=0;
 c.listDocConversations=async args=>{
  window.chatReadCount++;
  const p=await read({...args,cursor:null,limit:1});
  const n=Number(args.cursor||0);
  p.conversations=[{...p.conversations[0],id:'00000000-0000-4000-8000-00000000000'+n,title:'Synthetic chat '+n}];
  p.more=n<3;p.next_cursor=n<3?String(n+1):null;p.visible_conversation_count=4;
  if(window.holdChats)await new Promise(resolve=>window.chatResponses.push(resolve));
  return p;
 };`;
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/doc-chats', {waitUntil:'domcontentloaded'});
 for(let count=2;count<=4;count++){
  await page.locator('#showMoreConversations').click();
  await page.waitForFunction(n=>document.querySelectorAll('#conversationList [data-conversation]').length===n,count);
 }
 await page.evaluate(async()=>{window.chatView=(await import('/js/conversations.js')).view;window.holdChats=true;});
 await online(page);
 for(let n=0;n<3;n++){
  await page.waitForFunction(()=>window.chatResponses.length===1);
  await page.clock.fastForward(9000);await page.evaluate(()=>window.chatResponses.shift()());
 }
 await page.waitForFunction(()=>window.chatResponses.length===1);
 await page.clock.fastForward(9000);await page.evaluate(()=>window.chatResponses.shift()());
 await page.evaluate(()=>window.holdChats=false);
 // Give any uncancelled final response a chance to apply before checking.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 assert.equal(await page.evaluate(()=>window.chatView.list.state),'unavailable');
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),0);
 await page.clock.runFor(120_000);await online(page);await page.waitForFunction(()=>window.chatView.list.state==='read' && window.chatView.list.rows.length===4);
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),4);assert.deepEqual(errors,[]);
});

test('PR119 finding 8: a hung Home read expires and a late response cannot overwrite recovery',async t=>{
 const hooks=`const read=c.getHomeAgenda;window.homeReads??=0;c.getHomeAgenda=async args=>{const p=await read.call(c,args);if(!args?.signal)return p;if(++window.homeReads===2){window.homeWaiting=true;await new Promise(r=>window.releaseHome=r);return {...p,deals:[]};}return p;};`;
 const {page,errors}=await open(t,{clientHooks:hooks});
 await page.goto(origin+'/review-workflows', {waitUntil:'domcontentloaded'});await page.waitForFunction(()=>/Active deals: \d/.test(document.querySelector('#dealCounts')?.textContent || ''));
 const expected=await page.locator('#dealCounts').textContent();
 await online(page);await page.waitForFunction(()=>window.homeWaiting);
 await page.clock.runFor(150_000);await online(page);
 await page.waitForFunction(expected=>window.homeReads>=3 && document.querySelector('#dealCounts')?.textContent===expected,expected);
 await page.evaluate(()=>window.releaseHome());
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));
 assert.equal(await page.locator('#dealCounts').textContent(),expected);
 assert.equal(await page.locator('#retryHome').count(),0);assert.deepEqual(errors,[]);
});


test('all legacy deal links open the shared addressable snapshot',async t=>{
 const {page,errors}=await open(t);await page.goto(origin+'/index.html',{waitUntil:'domcontentloaded'});
 await page.locator('.deal-link').first().click();
 await page.waitForURL('**/deals?deal=*');
 await page.locator('#detailUpdateForm').waitFor();
 assert.equal(await page.locator('#detailUpdateForm textarea').inputValue(),'');
 assert.equal(await page.locator('.phase-rail').count(),1);
 assert.deepEqual(errors,[]);
});


test('PR119 finding 5: Doc Chats refresh keeps loaded conversations and turns',async t=>{
 const {page,errors}=await open(t,{smallChats:true});await page.goto(origin+'/doc-chats', {waitUntil:'domcontentloaded'});
 await page.locator('#showMoreConversations').click();await page.waitForFunction(()=>document.querySelectorAll('#conversationList [data-conversation]').length===2);
 await online(page);await waitForAsync(page, async()=> (await import('/js/conversations.js')).view.list.state==='read');
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),2);
 await page.locator('#conversationList [data-conversation] button[data-open]').first().click();
 await page.locator('#showMore').click();await page.waitForFunction(()=>document.querySelectorAll('#turnList .turn').length===2);
 await online(page);await waitForAsync(page, async()=> (await import('/js/conversations.js')).view.conversation.state==='read');
 assert.equal(await page.locator('#turnList .turn').count(),2);assert.deepEqual(errors,[]);
});
