import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBoundary, SESSION_TRUST_MS } from '../js/private-session.js';
const session = actor => ({actor:{slug:actor},csrf_token:`synthetic-${actor}`});
const defer = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
// Mirrors the old system: a POST whose CSRF token is not the cookie session's is refused.
const csrfServer=(identity,effect)=>async(path,init={})=>{
 if(path==='/auth/session')return Response.json(identity());
 const token=new Headers(init.headers).get('x-carr-csrf');
 if(token!==null&&token!==identity().csrf_token)return Response.json({error:'forbidden'},{status:403});
 return effect(path,init);
};
for(const change of ['switch-user','renew-session']) test(`F01: ${change} clears the view and refuses an old editor's mutation before it takes effect`,async()=>{
 let identity=session('joe'),visible=['Joe private title'],sent=0;
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:csrfServer(()=>identity,()=>{sent++;return Response.json({private:'Joe content'});})});
 await boundary.fetch('/api/private');assert.equal(sent,1);
 identity=change==='switch-user'?session('dell'):{...session('joe'),csrf_token:'synthetic-renewed'};
 await assert.rejects(boundary.fetch('/mcp',{method:'POST',body:'old editor intent'}),{code:'authentication_required'});
 assert.deepEqual(visible,[]);assert.equal(sent,1);
});
test('F01: a newer denial aborts pending reads, and a transport ignoring abort cannot return its old private payload',async()=>{
 let visible=['Joe private title'],pending=defer(),signal;
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:async(path,init)=>{
   if(path==='/auth/session')return Response.json(session('joe'));
   if(path==='/denied')return new Response('{}',{status:403});
   signal=init.signal;return pending.promise;
 }});
 const old=boundary.fetch('/old');
 await new Promise(r=>setTimeout(r,0));
 await assert.rejects(boundary.fetch('/denied'),{code:'authentication_required'});
 assert.equal(signal.aborted,true);assert.deepEqual(visible,[]);
 pending.resolve(Response.json({private:'Joe late content'}));
 await assert.rejects(old,{code:'authentication_required'});
});
test('F01: a POST after a cookie switch is refused before it takes effect, even inside the trust window',async()=>{
 let identity=session('joe'),visible=['Joe private title'];
 const boundary=createSessionBoundary({invalidate(){visible=[];},fetchImpl:csrfServer(()=>identity,()=>Response.json({private:'Dell content'}))});
 await boundary.verify();
 identity=session('dell');
 await assert.rejects(boundary.fetch('/mcp',{method:'POST',body:'{}'}),{code:'authentication_required'});
 assert.deepEqual(visible,[]);
});
test('repeated requests inside the trust window share one sign-in check, and the next window checks again',async()=>{
 let clock=0,checks=0,sent=0;
 const boundary=createSessionBoundary({invalidate(){},now:()=>clock,fetchImpl:async path=>{
   if(path==='/auth/session'){checks++;return Response.json(session('joe'));}
   sent++;return Response.json({ok:true});
 }});
 await Promise.all([boundary.fetch('/a'),boundary.fetch('/b')]);
 for(clock=1_000;clock<SESSION_TRUST_MS;clock+=30_000)await boundary.fetch('/poll');
 assert.equal(checks,1);
 clock=SESSION_TRUST_MS;await boundary.fetch('/poll');
 assert.equal(checks,2);assert.equal(sent,2+Math.ceil((SESSION_TRUST_MS-1_000)/30_000)+1);
});
test('a cookie switch on a GET read is trusted inside the window and caught by the first request after it',async()=>{
 let clock=0,identity=session('joe'),reason=null,sent=0;
 const boundary=createSessionBoundary({invalidate(why){reason=why;},now:()=>clock,fetchImpl:async path=>{
   if(path==='/auth/session')return Response.json(identity);
   sent++;return Response.json({ok:true});
 }});
 await boundary.fetch('/api/private');
 identity=session('dell');clock=SESSION_TRUST_MS-1;
 await boundary.fetch('/api/private');
 assert.equal(reason,null);
 clock=SESSION_TRUST_MS;
 await assert.rejects(boundary.fetch('/api/private'),{code:'authentication_required'});
 assert.equal(reason,'session-changed');assert.equal(sent,2);
});
test('an unauthorized answer inside the trust window ends the view and refuses later requests and checks',async()=>{
 let checks=0,reason=null,sent=0,expired=false;
 const boundary=createSessionBoundary({invalidate(why){reason=why;},fetchImpl:async path=>{
   if(path==='/auth/session'){checks++;return Response.json(session('joe'));}
   sent++;return expired?new Response('{}',{status:401}):Response.json({ok:true});
 }});
 await boundary.fetch('/api/private');
 expired=true;
 await assert.rejects(boundary.fetch('/api/private'),{code:'authentication_required'});
 assert.equal(reason,'denied');assert.equal(boundary.revoked,true);
 await assert.rejects(boundary.fetch('/api/private'),{code:'authentication_required'});
 await assert.rejects(boundary.verify(),{code:'authentication_required'});
 assert.equal(checks,1);assert.equal(sent,2);
});
test('a write reading the session inside the trust window gets a fresh check that catches a switch',async()=>{
 let identity=session('joe'),reason=null,checks=0;
 const boundary=createSessionBoundary({invalidate(why){reason=why;},fetchImpl:async path=>{
   if(path==='/auth/session'){checks++;return Response.json(identity);}
   return Response.json({ok:true});
 }});
 assert.equal((await (await boundary.fetch('/auth/session')).json()).actor.slug,'joe');
 identity=session('dell');
 await assert.rejects(boundary.fetch('/auth/session'),{code:'authentication_required'});
 assert.equal(reason,'session-changed');assert.equal(checks,2);
});
test('after sign-out no later request or check reuses the trusted session',async()=>{
 let reason=null,sent=0;
 const boundary=createSessionBoundary({invalidate(why){reason=why;},fetchImpl:async path=>{
   if(path==='/auth/session')return Response.json(session('joe'));
   sent++;return Response.json({ok:true});
 }});
 await boundary.fetch('/api/private');
 boundary.revoke('signed-out');
 assert.equal(reason,'signed-out');
 await assert.rejects(boundary.verify(),{code:'authentication_required'});
 await assert.rejects(boundary.fetch('/api/private'),{code:'authentication_required'});
 assert.equal(sent,1);
});
test('F01: a same-session network outage does not revoke the view or misclassify it as sign-out',async()=>{
 let invalidated=false;
 const boundary=createSessionBoundary({invalidate(){invalidated=true;},fetchImpl:async path=>{
   if(path==='/auth/session')return Response.json(session('joe'));
   throw Error('offline');
 }});
 await assert.rejects(boundary.fetch('/api/private'),/offline/);
 assert.equal(invalidated,false);
});
for(const code of ['forbidden','AUTHORIZATION_REFUSED','AUTHENTICATION_REQUIRED']) test(`F01: explicit MCP ${code} revokes every view even with HTTP 200`,async()=>{
 let invalidated=false;
 const boundary=createSessionBoundary({invalidate(){invalidated=true;},fetchImpl:async path=>path==='/auth/session'?Response.json(session('joe')):Response.json({result:{isError:true,content:[{type:'text',text:JSON.stringify({error:code})}]}})});
 await assert.rejects(boundary.fetch('/mcp'),{code:'authentication_required'});assert.equal(invalidated,true);
});
test('public Status may start signed out, but loses the whole authenticated view after a verified session is denied',async()=>{
 let signedIn=false,invalidated=false,clock=0;
 const boundary=createSessionBoundary({anonymousDiagnostics:true,now:()=>clock,invalidate(){invalidated=true;},fetchImpl:async()=>signedIn?Response.json(session('joe')):new Response('{}',{status:401})});
 await assert.rejects(boundary.verify(),{code:'authentication_required'});assert.equal(invalidated,false);
 signedIn=true;await boundary.verify();signedIn=false;clock=SESSION_TRUST_MS;
 await assert.rejects(boundary.verify(),{code:'authentication_required'});assert.equal(invalidated,true);
});

test('F01: Model Room mutation stays bound to the session verified before the cookie switches', async () => {
 const { createLiveClient } = await import('../js/live-client.js');
 const { composerRequest } = await import('../js/model-room-model.js');
 let identity = session('joe');
 const effects = [];
 const boundary = createSessionBoundary({ invalidate() {}, fetchImpl: async (path, init) => {
   if (path === '/auth/session') return Response.json(identity);
   identity = session('dell');
   if (new Headers(init.headers).has('x-carr-csrf') && new Headers(init.headers).get('x-carr-csrf') !== identity.csrf_token) return Response.json({error:'forbidden'}, {status:403});
   effects.push(identity.actor.slug);
   return Response.json({result:{content:[{type:'text',text:JSON.stringify({ok:true})}]}});
 }});
 const client = createLiveClient({fetchImpl:(...args) => boundary.fetch(...args)});
 await assert.rejects(client.addRoomTurn(composerRequest({text:'Synthetic editor intent'})));
 assert.deepEqual(effects, []);
 assert.equal(boundary.revoked, true);
});

test('F01: a retained operation cannot replace its original session token with the current one', async () => {
 let sent = 0;
 const boundary = createSessionBoundary({invalidate() {}, fetchImpl:async path => {
   if (path === '/auth/session') return Response.json(session('dell'));
   sent++; return Response.json({ok:true});
 }});
 await assert.rejects(boundary.fetch('/mcp', {method:'POST', headers:{'x-carr-csrf':'synthetic-joe'}}), {code:'authentication_required'});
 assert.equal(sent, 0);
});
