import {fakeRequests,assert,launch,projection,send,waitFor,watchThread,world} from './lib.mjs';
export const appChecks=[{name:'mcp-decision-app',capability:'5-mcp-app',fn:async(ctx)=>{
 const s=await world(ctx);const id=await launch(s.ca,s.projectId,'Show decision [[fake:tool decision_decision {"question":"Choose the next step"}]]','Decision app');
 const t=watchThread(s.ca,id);await waitFor('app turn',()=>t.settled(),90000);
 const p=await projection(s.cb,id);const item=p.turnItems.find(i=>i.type==='dynamic_tool'&&i.output?.t3McpApp);
 assert(item,`no app item: ${JSON.stringify(p.turnItems.filter(i=>i.type==='dynamic_tool')).slice(0,1800)}`);
 const reference=item.output.t3McpApp;const base={threadId:id,itemId:item.id};
 const info=await s.cb.ok('mcpApps.toolInfo',{...base,name:'choose'});assert(info.callable,'choose not callable');
 const res=await s.cb.ok('mcpApps.readResource',{...base,uri:reference.resourceUri});assert(JSON.stringify(res).includes('Choose a next step'),'app resource missing');
 const choice=await s.cb.ok('mcpApps.callTool',{...base,name:'choose',arguments:{choice:'Proceed'}});assert(!choice.isError,'choice failed');
 await s.cb.ok('mcpApps.updateModelContext',{...base,conversationThreadId:id,content:choice.content});
 await send(s.ca,id,'What did I choose?');await waitFor('next model turn',async()=>(await fakeRequests()).some(r=>JSON.stringify(r.messages).includes('User selected: Proceed')),60000);
 t.stop();return 'A real MCP tool produced a durable app reference; another member loaded it, called choose, updated model context, and the next turn received the choice';
}}];
