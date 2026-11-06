'use strict';
const {uuid,validDate,heads}=require('./model.cjs');
const ID=/^[a-f0-9-]{36}$/,NOTE=/^note:(\d{4}-\d{2}-\d{2}):(intent|diary)$/;
function policy(raw={mode:'days',days:30,count:100}){
 const out={mode:raw.mode,days:Number(raw.days??30),count:Number(raw.count??100)};
 if(!['days','count','both','off'].includes(out.mode)||!Number.isInteger(out.days)||out.days<1||out.days>3650||!Number.isInteger(out.count)||out.count<1||out.count>10000)throw Error('请设置有效的历史保留天数或数量');return out;
}
function validateEvent(e){
 if(e?.format!=='riye-retention'||e.schema!==1||!ID.test(e.id)||!Number.isFinite(Date.parse(e.timestamp))||!Array.isArray(e.retired)||e.retired.length>1000000||!e.firstEditedAt||typeof e.firstEditedAt!=='object')throw Error('历史清理记录不正确');
 const result={format:e.format,schema:1,id:e.id,timestamp:e.timestamp,policy:policy(e.policy),retired:[],firstEditedAt:{}};
 const seen=new Set();for(const r of e.retired){const match=NOTE.exec(r.entityId);if(!ID.test(r.id)||seen.has(r.id)||!match||!validDate(match[1])||!Array.isArray(r.parents)||r.parents.length>100||r.parents.some(id=>!ID.test(id)||id===r.id))throw Error('历史清理关联记录不正确');seen.add(r.id);result.retired.push({id:r.id,entityId:r.entityId,parents:[...new Set(r.parents)]});}
 for(const [id,time]of Object.entries(e.firstEditedAt)){const match=NOTE.exec(id);if(!match||!validDate(match[1])||!Number.isFinite(Date.parse(time)))throw Error('首次记录时间不正确');result.firstEditedAt[id]=time;}
 return result;
}
function state(events=[]){
 const retired=new Map(),firstEditedAt=new Map();let latest=null;
 for(const event of events){if(!latest||event.timestamp>latest.timestamp||event.timestamp===latest.timestamp&&event.id>latest.id)latest=event;
  for(const r of event.retired){const old=retired.get(r.id);if(old&&JSON.stringify(old)!==JSON.stringify(r))throw Error('历史清理记录存在冲突');retired.set(r.id,r);}
  for(const [id,time]of Object.entries(event.firstEditedAt))if(!firstEditedAt.has(id)||time<firstEditedAt.get(id))firstEditedAt.set(id,time);
 }return{retired,firstEditedAt,policy:latest?.policy||null};
}
function graph(revisions,retired){
 const cache=new Map(),visiting=new Set();
 function resolve(id,entityId){
  if(!retired.has(id))return[id];const r=retired.get(id);if(r.entityId!==entityId)throw Error('清理记录关联了另一篇内容');
  if(cache.has(id))return cache.get(id);if(visiting.has(id))throw Error('清理记录版本关系损坏');
  // Iterative traversal supports years of automatic drafts without overflowing
  // the mobile JavaScript stack.
  const stack=[[id,false]];
  while(stack.length){const [next,done]=stack.pop();if(cache.has(next))continue;const old=retired.get(next);if(!old)continue;if(old.entityId!==entityId)throw Error('清理记录关联了另一篇内容');
   if(done){visiting.delete(next);cache.set(next,[...new Set(old.parents.flatMap(p=>retired.has(p)?cache.get(p):[p]))]);continue;}
   if(visiting.has(next))throw Error('清理记录版本关系损坏');visiting.add(next);stack.push([next,true]);for(const p of old.parents)if(retired.has(p)&&!cache.has(p))stack.push([p,false]);
  }return cache.get(id);
 }
 return revisions.filter(r=>!retired.has(r.id)).map(r=>({...r,parents:[...new Set(r.parents.flatMap(id=>resolve(id,r.entityId)))]}));
}
function plan(store,raw,now=Date.now()){
 const selected=policy(raw),keep=new Set(),firstEditedAt={},visible=new Set();let histories=0;
 for(const entityId of store.entities.keys()){
  const record=store.get(entityId);for(const r of record.heads)keep.add(r.id);
  if(!entityId.startsWith('note:')||selected.mode==='off'){for(const r of store.all(entityId))keep.add(r.id);if(entityId.startsWith('note:'))for(const r of store.versions(entityId))if(!record.heads.some(h=>h.id===r.id))visible.add(r.id);continue;}
  if(record.firstEditedAt)firstEditedAt[entityId]=record.firstEditedAt;
  const current=new Set(record.heads.map(r=>r.id)),versions=store.versions(entityId).filter(r=>!current.has(r.id)).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id));
  for(let i=0;i<versions.length;i++){const r=versions[i];if((selected.mode==='days'||selected.mode==='both')&&Date.parse(r.timestamp)<now-selected.days*86400000)continue;if((selected.mode==='count'||selected.mode==='both')&&i>=selected.count)continue;keep.add(r.id);visible.add(r.id);}
  histories+=versions.filter(r=>!keep.has(r.id)).length;
 }
 const retired=[...store.revisions.values()].filter(r=>!keep.has(r.id)).map(({id,entityId,parents})=>({id,entityId,parents}));
 const kept=[...store.revisions.values()].filter(r=>keep.has(r.id)),photos=new Set(kept.flatMap(r=>r.payload?.blocks?.filter(b=>b.kind==='image').map(b=>b.assetId)||[]));
 return{policy:selected,retired,firstEditedAt,histories,visible:[...visible],assets:store.assetIds().filter(id=>!photos.has(id)),remaining:kept.length};
}
function eventFor(plan,timestamp=new Date().toISOString()){return validateEvent({format:'riye-retention',schema:1,id:uuid(),timestamp,policy:plan.policy,retired:plan.retired,firstEditedAt:plan.firstEditedAt});}
module.exports={policy,validateEvent,state,graph,plan,eventFor};
