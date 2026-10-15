'use strict';
const crypto = require('node:crypto');
const uuid = () => crypto.randomUUID();
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s+'T12:00:00'); return !isNaN(d) && localDate(d) === s;
}
function str(x,max=1000000) { if(typeof x!=='string'||x.length>max) throw Error('文字格式或长度不正确'); return x; }
function blocks(value) {
  if(!Array.isArray(value)||value.length>10000) throw Error('正文格式不正确');
  return value.map(b=> {
    if(!b||typeof b!=='object') throw Error('正文格式不正确');
    const id=str(b.id,100);
    if(b.kind==='text') return {id,kind:'text',text:str(b.text)};
    if(b.kind==='check') return {id,kind:'check',text:str(b.text),checked:!!b.checked};
    if(b.kind==='image'&&/^[a-f0-9]{64}$/.test(b.assetId)) return {id,kind:'image',assetId:b.assetId,caption:str(b.caption||'',2000)};
    throw Error('不支持的正文内容');
  });
}
function time(value) { if(value===''||value==null)return ''; if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('时间格式不正确'); return value; }
function date(value) { if(!validDate(value)) throw Error('日期不正确'); return value; }
function plan(value) {
  if(!value||typeof value!=='object')throw Error('计划格式不正确');
  const p={title:str(value.title,200).trim(),kind:value.kind,time:time(value.time),content:str(value.content||'')};
  if(!p.title)throw Error('请填写计划名称');
  if(p.kind==='once')p.date=date(value.date);
  else if(p.kind==='weekly') {
    if(!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.some(x=>!Number.isInteger(x)||x<0||x>6))throw Error('请选择重复的星期');
    p.weekdays=[...new Set(value.weekdays)];p.startDate=date(value.startDate);p.endDate=value.endDate?date(value.endDate):'';
    if(p.endDate&&p.endDate<p.startDate)throw Error('结束日期不能早于开始日期');
    p.weekContent={};for(const day of p.weekdays)p.weekContent[day]=str(value.weekContent?.[day]||p.content);
  } else if(p.kind==='course') {
    if(!Array.isArray(value.lessons)||!value.lessons.length||value.lessons.length>500)throw Error('请至少添加一节课或一个阶段');
    p.lessons=value.lessons.map(x=>({id:str(x.id,100),title:str(x.title,200).trim()||'课程',date:date(x.date),time:time(x.time),content:str(x.content||'')}));
    if(new Set(p.lessons.map(x=>x.id)).size!==p.lessons.length)throw Error('课程编号重复');
  } else throw Error('不支持的计划类型');
  return p;
}
function validateRevision(r) {
  if(!r||r.schema!==1||!/^[a-f0-9-]{36}$/.test(r.id)||!/^[a-f0-9-]{36}$/.test(r.deviceId))throw Error('记录格式不正确');
  const note=/^note:(\d{4}-\d{2}-\d{2}):(intent|diary)$/.exec(r.entityId);
  if(!(note&&validDate(note[1]))&&!/^plan:[a-f0-9-]{36}$/.test(r.entityId))throw Error('记录类型不正确');
  if(!Array.isArray(r.parents)||r.parents.length>100||r.parents.some(x=>!/^[a-f0-9-]{36}$/.test(x)||x===r.id))throw Error('记录版本不正确');
  if(!Number.isFinite(Date.parse(r.timestamp))||!validDate(r.effectiveDate))throw Error('记录时间不正确');
  const out={schema:1,id:r.id,entityId:r.entityId,deviceId:r.deviceId,parents:[...new Set(r.parents)],timestamp:r.timestamp,effectiveDate:r.effectiveDate,deleted:!!r.deleted,payload:null};
  if(!out.deleted)out.payload=note?{blocks:blocks(r.payload?.blocks)}:plan(r.payload);
  if(Buffer.byteLength(JSON.stringify(out))>4*1024*1024)throw Error('单条记录过大');
  return out;
}
function heads(revisions) { const parentIds=new Set(revisions.flatMap(r=>r.parents));return revisions.filter(r=>!parentIds.has(r.id)).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)); }
function assetsOf(r) { return r.payload?.blocks?.filter(b=>b.kind==='image').map(b=>b.assetId)||[]; }
function hasNoteContent(r) { return !!r&&!r.deleted&&!!r.payload?.blocks?.some(b=>b.kind==='image'||b.text?.trim()||(b.kind==='check'&&b.checked)); }
// Compare user content, excluding generated editor/lesson IDs and empty blocks.
function contentKey(r){
  if(r.deleted)return '';
  if(r.entityId.startsWith('note:')){
    if(!hasNoteContent(r))return '';
    return JSON.stringify(r.payload.blocks.filter(b=>b.kind==='image'||b.text?.trim()||(b.kind==='check'&&b.checked)).map(({id,...b})=>b));
  }
  const p={...r.payload};
  if(p.weekdays){p.weekdays=[...p.weekdays].sort();p.weekContent=Object.fromEntries(p.weekdays.map(d=>[d,p.weekContent[d]]));}
  if(p.lessons)p.lessons=p.lessons.map(({id,...l})=>l);
  return JSON.stringify({effectiveDate:r.effectiveDate,payload:p});
}
function selectHeads(h){
  const groups=new Map();for(const r of h){const key=contentKey(r);if(key)groups.set(key,r);}
  const candidates=[...groups.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)),revision=candidates.at(-1)||h.filter(r=>r.deleted).at(-1)||h.at(-1)||null;
  return {revision,conflict:candidates.length>1,conflictHeads:candidates};
}
function validateDevice(raw){
  if(raw?.format!=='riye-device'||raw.schema!==1||!/^[a-f0-9-]{36}$/.test(raw.deviceId)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>40||/[\x00-\x1f\x7f]/.test(raw.name)||!Number.isFinite(Date.parse(raw.updatedAt)))throw Error('设备名称记录不正确');
  return {format:'riye-device',schema:1,deviceId:raw.deviceId,name:raw.name.trim(),updatedAt:new Date(raw.updatedAt).toISOString()};
}
function occurrence(p,entityId,day) {
  if(p.kind==='once'&&p.date===day)return [{id:entityId+'@'+day,entityId,title:p.title,content:p.content,time:p.time,date:day,kind:p.kind}];
  if(p.kind==='weekly'&&day>=p.startDate&&(!p.endDate||day<=p.endDate)){
    const wd=new Date(day+'T12:00:00').getDay();
    if(p.weekdays.includes(wd))return [{id:entityId+'@'+day,entityId,title:p.title,content:p.weekContent[wd]||p.content,time:p.time,date:day,kind:p.kind}];
  }
  if(p.kind==='course')return p.lessons.filter(l=>l.date===day).map(l=>({id:entityId+'@'+l.id,lessonId:l.id,entityId,title:p.title+' · '+l.title,content:l.content,time:l.time||p.time,date:day,kind:p.kind}));
  return [];
}
function sniffImage(b) {
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(b.length>=6&&/^GIF8[79]a$/.test(b.subarray(0,6).toString()))return 'image/gif';
  if(b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(b.length>=2&&b.subarray(0,2).toString()==='BM')return 'image/bmp';
  throw Error('请使用 PNG、JPEG、WebP、GIF 或 BMP 图片');
}
function validateGraph(revisions){
  const index=new Map(revisions.map(r=>[r.id,r])),children=new Map(),degree=new Map();
  for(const r of index.values()){
    degree.set(r.id,r.parents.length);
    for(const id of r.parents){if(index.get(id)?.entityId!==r.entityId)throw Error('记录缺少关联版本或关联了另一条记录');if(!children.has(id))children.set(id,[]);children.get(id).push(r.id);}
  }
  const queue=[...degree].filter(x=>x[1]===0).map(x=>x[0]);let count=0;
  for(let i=0;i<queue.length;i++){count++;for(const child of children.get(queue[i])||[]){degree.set(child,degree.get(child)-1);if(degree.get(child)===0)queue.push(child);}}
  if(count!==index.size)throw Error('记录版本关系损坏');
  return queue.map(id=>index.get(id));
}
module.exports={uuid,localDate,validDate,blocks,plan,validateRevision,heads,assetsOf,occurrence,sniffImage,validateGraph,hasNoteContent,validateDevice,selectHeads};
