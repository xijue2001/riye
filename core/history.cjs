'use strict';
const {heads,contentKey,hasNoteContent}=require('./model.cjs');

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
function historyVersions(revisions){
  const index=new Map(revisions.map(r=>[r.id,r])),current=heads(revisions).sort(newest),checkpoints=[];
  for(const child of revisions)for(const id of child.parents){
    const parent=index.get(id);
    if(parent&&!onlyAdds(parent,child))checkpoints.push(parent);
  }
  const seen=new Set(),result=[];
  // Current heads win over equal old checkpoints, regardless of clock skew.
  for(const r of [...current,...checkpoints.sort(newest)]){
    if(!r.deleted&&!hasNoteContent(r)&&r.entityId.startsWith('note:'))continue;
    const key=(r.deleted?'deleted:':'content:')+contentKey(r);
    if(seen.has(key))continue;seen.add(key);result.push(r);
  }
  return result;
}
module.exports={onlyAdds,historyVersions};
