// Bundled MCP application: a small decision card. Uses the standard MCP Apps postMessage protocol.
// No external resources, network or persisted browser state. The selected choice becomes model context.
export const SAMPLE_URI = 'ui://baskule/decision.html';
const tools = [
 {name:'decision', description:'Show an interactive decision card for the user to choose a next step.', inputSchema:{type:'object',properties:{question:{type:'string'}},required:['question']},_meta:{ui:{resourceUri:SAMPLE_URI,visibility:['model','app']}}},
 {name:'choose', description:'Validate the selected next step.', inputSchema:{type:'object',properties:{choice:{type:'string',enum:['Proceed','Revise','Pause']}},required:['choice']},_meta:{ui:{visibility:['app']}},annotations:{readOnlyHint:true}},
];
export const SAMPLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;margin:24px;color:#eee;background:#202326}h2{font-size:20px}button{font:inherit;padding:10px 18px;margin:4px;border:1px solid #666;border-radius:8px;background:#34393e;color:inherit}#status{min-height:24px}</style></head><body><h2 id="question">Choose a next step</h2><div><button>Proceed</button><button>Revise</button><button>Pause</button></div><p id="status" role="status">Connecting…</p><script>
let next=1;const pending=new Map();const request=(method,params)=>new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');setTimeout(()=>{if(pending.delete(id))reject(Error('Application disconnected. Reopen it from the conversation.'))},10000)});
addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}if(m.method==='ui/notifications/tool-input')document.querySelector('#question').textContent=m.params?.arguments?.question||'Choose a next step'});
request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Baskule decision',version:'0.5.0'},appCapabilities:{}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.querySelector('#status').textContent='Choose an option to share with the assistant.'}).catch(e=>document.querySelector('#status').textContent=e.message);
for(const b of document.querySelectorAll('button'))b.onclick=async()=>{try{document.querySelector('#status').textContent='Saving…';const r=await request('tools/call',{name:'choose',arguments:{choice:b.textContent}});if(r.isError)throw Error('Choice rejected');await request('ui/update-model-context',{content:r.content});document.querySelector('#status').textContent='Shared with the assistant: '+b.textContent}catch(e){document.querySelector('#status').textContent=e.message}};
</script></body></html>`;
export async function sampleAppHandler(req: Request): Promise<Response> {
 if(req.method==='DELETE')return new Response(null,{status:204});
 if(req.method!=='POST')return new Response(null,{status:405});
 const m=await req.json() as {id?:number|string;method:string;params?:any};
 if(m.id===undefined)return new Response(null,{status:202});
 let result:unknown;
 switch(m.method){
 case 'initialize':result={protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{}},serverInfo:{name:'Baskule decision',version:'0.5.0'}};break;
 case 'ping':result={};break;
 case 'tools/list':result={tools};break;
 case 'resources/list':result={resources:[{uri:SAMPLE_URI,name:'Decision card',mimeType:'text/html;profile=mcp-app'}]};break;
 case 'resources/templates/list':result={resourceTemplates:[]};break;
 case 'prompts/list':result={prompts:[]};break;
 case 'resources/read':if(m.params?.uri===SAMPLE_URI)result={contents:[{uri:SAMPLE_URI,mimeType:'text/html;profile=mcp-app',text:SAMPLE_HTML}]};break;
 case 'tools/call':
  if(m.params?.name==='decision')result={content:[{type:'text',text:String(m.params.arguments?.question??'Choose a next step')} ]};
  else if(m.params?.name==='choose'){const choice=m.params.arguments?.choice;result=['Proceed','Revise','Pause'].includes(choice)?{content:[{type:'text',text:'User selected: '+choice}]}:{isError:true,content:[{type:'text',text:'Unsupported choice'}]};}
  break;
 }
 return Response.json(result===undefined?{jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Unsupported MCP request'}}:{jsonrpc:'2.0',id:m.id,result});
}
