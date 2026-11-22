import {fileURLToPath} from 'node:url';
import {appAssetSnapshot} from '../scripts/fixture-app-assets.mjs';
import {handleDoctorcreRequest} from '../src/worker.js';
import {workspace,detail,emptyQuietFollowUps} from './leads-workspace-fixture.mjs';
let assetSnapshot;

export async function routeLeads(page,{getBoard=workspace,getQuiet=emptyQuietFollowUps,getReasons=()=>({ok:true,contract:"practice-origination.v1",cards:[],coverage:[],next_cursor:null,outreach_started:false}),getDetail=(row)=>detail(row),actor='example-partner',saveLead,onRead=()=>{},onWrite=()=>{}}={}) {
 async function readBoard(args) {
  onRead();
  const board = await getBoard();
  if (!args.lead_id) return board;
  return { ...board, detail: await getDetail(board.leads.find(row => row.id === args.lead_id), args) };
 }
 const engine = saveLead && {
  ENGINE_ROUTING: { get: async key => ['leads-from-engine', 'deals-saves-from-engine'].includes(key) ? 'on' : null },
  ENGINE: { fetch: async request => {
   const { pathname, searchParams } = new URL(request.url);
   if (pathname === '/api/engine/leads') return Response.json(await readBoard(Object.fromEntries(searchParams)));
   if (pathname === '/api/engine/quiet-follow-ups') return Response.json(await getQuiet());
   if (pathname === '/api/engine/reasons-to-reach-out') return Response.json(await getReasons(Object.fromEntries(searchParams)));
   const change = /^\/api\/engine\/leads\/([^/]+)\/changes$/.exec(pathname);
   if (change) return saveLead(change[1], await request.json());
   return new Response(null, { status: 404 });
  } },
 };
 const snapshot = await (assetSnapshot ||= appAssetSnapshot(undefined, fileURLToPath(new URL('../', import.meta.url))));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!=='http://localhost')return route.abort();
  const env={APP_ENV:'fixture',...(url.pathname === '/mcp' ? engine : {}),CARR:{fetch:async request=>{
   const path=new URL(request.url).pathname;
   if(path==='/mcp'){
    const p=(await request.json()).params;let value={ok:true};
    if(p.name==='list-practice-origination')value=await getReasons(p.arguments);
    else if(p.name==='quiet-follow-ups')value=await getQuiet();
    else if(p.name==='read-home-agenda')value={schema_version:'home-agenda.v1',actor:'example-partner',deals:[]};
    else if(p.name==='deal-room-board')value={actor:'example-partner',deals:[]};
    else if(p.name==='lead-board')value=await readBoard(p.arguments);
    else onWrite(p);
    return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(value)}]}});
   }
   if(path === '/auth/session' || path.startsWith('/api/'))return Response.json({actor:{slug:actor},csrf_token:'synthetic-test-token',items:[],counts:{}});
   return new Response('synthetic auth gate');
  }},ASSETS:{fetch:async request=>{
   const asset=snapshot.get(new URL(request.url).pathname);
   return asset ? new Response(asset.body,{status:asset.status || 200,headers:{...asset.headers,'content-type':asset.contentType || 'application/octet-stream'}}) : new Response(null,{status:404});
  }}};
  const response=await handleDoctorcreRequest(new Request(req.url(),{method:req.method(),...(req.postData()?{body:req.postData()}:{}),headers:req.headers()}),env);
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
}
