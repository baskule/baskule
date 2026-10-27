import { FRONT, MODEL, assert, waitFor, world } from './lib.mjs';
const tasks = async (c) => (await c.ok('scheduledTasks.list', {})).tasks;
export const scheduleChecks = [
 {name:'schedule-lifecycle-and-webhook', capability:'3-schedules', fn:async(ctx)=>{
  const s=await world(ctx);
  const input={title:'Webhook '+ctx.run,prompt:'Payload {{body.message}} [[fake:text webhook-finished]]', enabled:true,schedule:{type:'webhook',dedupe:{replayKey:'{{body.id}}'}},projectId:s.projectId,workspaceStrategy:{type:'root'},modelSelection:MODEL,runtimeMode:'full-access',interactionMode:'default'};
  const made=await s.ca.ok('scheduledTasks.upsert',input); const task=made.task??made;
  assert(task.webhook?.url?.startsWith(FRONT+'/hooks/'),JSON.stringify(task));
  const post=(url,id)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,message:'hello'})});
  const r=await post(task.webhook.url,'same'); assert(r.ok,`hook ${r.status} ${await r.text()}`);
  const repeat=await post(task.webhook.url,'same'); assert(repeat.ok,`repeat ${repeat.status}`); assert(repeat.headers.get('x-t3-hook-outcome')==='duplicate',`replay outcome: ${repeat.headers.get('x-t3-hook-outcome')} ${await repeat.text()}`);
  const deliveries=await waitFor('two delivery records',async()=>{const d=await s.cb.ok('scheduledTasks.listWebhookDeliveries',{id:task.id,acceptAnyOutcome:true});return d.deliveries.length>=2?d.deliveries:null},30000);
  assert(deliveries.some(d=>d.outcome==='duplicate'),JSON.stringify(deliveries));
  await s.ca.ok('scheduledTasks.setEnabled',{id:task.id,enabled:false});
  const disabled=await post(task.webhook.url,'disabled'); assert(!disabled.ok,'disabled hook accepted');
  await s.ca.ok('scheduledTasks.setEnabled',{id:task.id,enabled:true});
  await s.ca.ok('scheduledTasks.rotateWebhookToken',{id:task.id});
  assert(!(await post(task.webhook.url,'old')).ok,'old webhook token remained valid');
  const updated=await s.ca.ok('scheduledTasks.upsert',{...input,id:task.id,title:'Edited webhook '+ctx.run,schedule:{type:'interval',everyMs:3600000}});
  assert((updated.task??updated).title==='Edited webhook '+ctx.run,'edit lost');
  await s.cb.ok('scheduledTasks.runNow',{id:task.id});
  await waitFor('manual run recorded',async()=>{const t=(await tasks(s.cb)).find(t=>t.id===task.id);return t?.runCount>=2?t:null},60000);
  await s.ca.ok('scheduledTasks.delete',{id:task.id});
  assert(!(await tasks(s.cb)).some(t=>t.id===task.id),'delete lost');
  return 'Webhook delivery + replay dedupe, disable, token rotation, edit, manual run, delete shared across two members';
 }}
 // An interval schedule waking an asleep space through the DO alarm is proven one level lower, without Docker:
 // platform/src/space/test/run.mjs "schedule-fires-via-alarm" (same 60 s minimum interval, so it is not repeated here).
];
