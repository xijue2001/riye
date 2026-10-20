'use strict';
const {heads,contentKey,hasNoteContent,validDate}=require('./model.cjs');

const uuidPattern=/^[a-f0-9-]{36}$/;
function validateCheckpoint(value){
  const note=/^note:(\d{4}-\d{2}-\d{2}):(intent|diary)$/.exec(value?.entityId);
  if(value?.format!=='riye-checkpoint'||value.schema!==1||!uuidPattern.test(value.id)||!uuidPattern.test(value.revisionId)||!uuidPattern.test(value.deviceId)||!note||!validDate(note[1])||!['start','save'].includes(value.kind)||!Number.isFinite(Date.parse(value.timestamp)))throw Error('历史保存点格式不正确');
  return {format:'riye-checkpoint',schema:1,id:value.id,entityId:value.entityId,revisionId:value.revisionId,deviceId:value.deviceId,kind:value.kind,timestamp:value.timestamp};
}
function ancestorIds(revision,index){
  const result=new Set(),pending=[revision.id];
  while(pending.length){const id=pending.pop();if(result.has(id))continue;result.add(id);pending.push(...(index.get(id)?.parents||[]));}
  return result;
}
function manualScope(revisions,checkpoints){
  const children=new Map();for(const r of revisions)for(const id of r.parents){if(!children.has(id))children.set(id,[]);children.get(id).push(r.id);}
  const result=new Set(),pending=checkpoints.filter(c=>c.kind==='start').map(c=>c.revisionId);
  while(pending.length){const id=pending.pop();if(result.has(id))continue;result.add(id);pending.push(...(children.get(id)||[]));}
  return result;
}

function includesInOrder(before,after){
  if(before===after)return true;
  const wanted=before[Symbol.iterator]();let next=wanted.next();
  for(const character of after){if(next.done)return true;if(character===next.value)next=wanted.next();}
  return next.done;
}
// Text is streamed across paragraph boundaries so inserting a newline or an
// image inside existing text is still an addition. Checks and images stay
// atomic: changing a check state, photo or its existing caption is an edit.
function* tokens(revision){
  for(const b of revision.payload?.blocks||[]){
    if(b.kind==='text'){if(!b.text.trim())continue;yield* b.text;}
    else if(b.kind==='check'){if(!b.text.trim()&&!b.checked)continue;yield b;}
    else yield b;
    yield '\n';
  }
}
function compatible(before,after){
  if(typeof before==='string'||typeof after==='string')return before===after;
  if(before.kind!==after.kind)return false;
  if(before.kind==='image')return before.assetId===after.assetId&&includesInOrder(before.caption||'',after.caption||'');
  return before.checked===after.checked&&includesInOrder(before.text,after.text);
}
function onlyAdds(before,after){
  if(contentKey(before)===contentKey(after))return true;
  if(!before.entityId.startsWith('note:'))return false;
  if(before.deleted)return false;
  if(!hasNoteContent(before))return true;
  if(after.deleted)return false;
  const wanted=tokens(before);let next=wanted.next();
  for(const token of tokens(after)){if(next.done)return true;if(compatible(next.value,token))next=wanted.next();}
  return next.done;
}
const newest=(a,b)=>b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id);
function historyVersions(revisions,events=[]){
  const index=new Map(revisions.map(r=>[r.id,r])),current=heads(revisions).sort(newest),checkpoints=[];
  const starts=new Set(events.filter(c=>c.kind==='start').map(c=>c.revisionId)),manual=manualScope(revisions,events),saved=new Map();
  for(const c of events.filter(c=>c.kind==='save').sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id))){
    const r=index.get(c.revisionId);if(r)saved.set(r.id,{...r,timestamp:c.timestamp,deviceId:c.deviceId,saved:true});
  }
  for(const child of revisions)for(const id of child.parents){
    const parent=index.get(id);
    if(parent&&(!manual.has(child.id)||starts.has(child.id))&&!onlyAdds(parent,child))checkpoints.push(parent);
  }
  checkpoints.push(...saved.values());
  const seen=new Set(),result=[];
  // Current heads win over equal old checkpoints, regardless of clock skew.
  for(const r of [...current,...checkpoints.sort(newest)]){
    if(!r.deleted&&!hasNoteContent(r)&&r.entityId.startsWith('note:')&&!saved.has(r.id)&&!(manual.has(r.id)&&current.some(x=>x.id===r.id)&&saved.size))continue;
    const key=(r.deleted?'deleted:':'content:')+contentKey(r);
    if(seen.has(key))continue;seen.add(key);result.push(saved.get(r.id)||r);
  }
  return result;
}
module.exports={onlyAdds,historyVersions,validateCheckpoint,ancestorIds,manualScope};
