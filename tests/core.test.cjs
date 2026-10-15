'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {Store}=require('../core/store.cjs');const {Sync,listing}=require('../core/dav.cjs');const {uuid,localDate,validateGraph}=require('../core/model.cjs');const {readZip,makeZip}=require('../core/zip.cjs');
const roots=[];function store(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-test-'));roots.push(root);return new Store(root);}
test.after(()=>{for(const p of roots)fs.rmSync(p,{recursive:true,force:true});});
const block=text=>({id:uuid(),kind:'text',text});const note='note:2026-10-14:diary';
function write(s,text,entityId=note,parents=s.get(entityId).heads.map(r=>r.id)){return s.save({entityId,parents,payload:{blocks:[block(text)]}}).revision;}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII=','base64');
async function server(){
  const files=new Map(),dirs=new Set(['/']),control={failAssetOnce:false,partialOnce:null,truncateSuccessOnce:false,denyExistingMkcol:false};
  const srv=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Basic '+Buffer.from('user:pass').toString('base64')){res.writeHead(401);res.end();return;}
    const p=new URL(req.url,'http://localhost').pathname;
    if(req.method==='MKCOL'){if(dirs.has(p)){res.writeHead(control.denyExistingMkcol?403:405);res.end();return;}dirs.add(p);res.writeHead(201);res.end();return;}
    if(req.method==='PROPFIND'){
      if(!dirs.has(p)){res.writeHead(404);res.end();return;}
      let xml='<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>'+p+'</D:href></D:response>';
      if(req.headers.depth!=='0')for(const f of files.keys())if(f.startsWith(p)&&!f.slice(p.length).includes('/'))xml+='<D:response><D:href>'+f+'</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
      if(control.afterList&&req.headers.depth==='1'&&p.endsWith('/revisions/'))await control.afterList();
      res.writeHead(207,{'Content-Type':'application/xml'});res.end(xml+'</D:multistatus>');return;
    }
    if(req.method==='PUT'){
      if(control.failAssetOnce&&p.includes('/assets/')){control.failAssetOnce=false;res.writeHead(503);res.end();return;}
      if(files.has(p)&&req.headers['if-none-match']==='*'){res.writeHead(412);res.end();return;}
      const chunks=[];for await(const x of req)chunks.push(x);let data=Buffer.concat(chunks);if(control.partialOnce&&p.includes('/'+control.partialOnce+'/')){control.partialOnce=null;files.set(p,data.subarray(0,7));res.writeHead(503);res.end();return;}if(control.truncateSuccessOnce&&p.includes('/assets/')){control.truncateSuccessOnce=false;data=data.subarray(0,7);}files.set(p,data);if(control.afterPut)await control.afterPut(p,data);res.writeHead(201);res.end();return;
    }
    if(req.method==='GET'){if(!files.has(p)){res.writeHead(404);res.end();return;}res.end(files.get(p));return;}
    if(req.method==='DELETE'){files.delete(p);res.writeHead(204);res.end();return;}
    res.writeHead(405);res.end();
  });await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  return {files,control,config:{primary:'http://127.0.0.1:'+srv.address().port,secondary:'',directory:'/日页 测试',username:'user',password:'pass',auto:false},close:()=>new Promise(resolve=>srv.close(resolve))};
}
test('offline data, checklist and original photo survive restart',()=>{
  const s=store(),photo=s.addAsset(png),blocks=[block('今天的记录'),{id:uuid(),kind:'check',text:'完成一课',checked:true},{id:uuid(),kind:'image',assetId:photo.assetId,caption:'截图'}];
  s.save({entityId:note,parents:[],payload:{blocks}});const reopened=new Store(s.root);assert.deepEqual(reopened.get(note).revision.payload.blocks,blocks);assert.deepEqual(reopened.readAsset(photo.assetId),png);
});
test('concurrent same-field edits retain both heads; explicit resolution keeps history',()=>{
  const s=store(),base=write(s,'原文');const a=write(s,'电脑修改',note,[base.id]),b=write(s,'手机离线修改',note,[base.id]);assert.equal(s.get(note).heads.length,2);
  write(s,'合并结果',note,[a.id,b.id]);assert.equal(s.get(note).heads.length,1);assert.equal(s.all(note).length,4);
});
test('separate intent and diary changes do not conflict',()=>{const s=store();write(s,'早上打算','note:2026-10-14:intent');write(s,'晚上日记');assert.equal(s.status().conflicts,0);});
test('empty branches including whitespace and unchecked blank items merge and stay hidden after restart',()=>{
 const s=store();write(s,'',note,[]);s.save({entityId:note,parents:[],payload:{blocks:[block(' \n\t'),{id:uuid(),kind:'check',text:'',checked:false}]}});
 assert.equal(s.status().conflicts,0);assert.equal(s.get(note).conflictHeads.length,0);assert.equal(s.reconcileConflicts().length,1);
 const reopened=new Store(s.root);assert.equal(reopened.get(note).heads.length,1);assert.equal(reopened.all(note).length,3);assert.equal(reopened.history()[0].hasDiary,false);assert.equal(reopened.reconcileConflicts().length,0);
});
test('a newer empty branch never hides older meaningful content or changes its first edit time',()=>{
 const s=store(),filled=write(s,'保留有内容的一方',note,[]),empty=write(s,'',note,[]);
 s.importRevision({...empty,id:uuid(),timestamp:'2099-01-01T00:00:00.000Z',parents:[empty.id]});
 assert.equal(s.get(note).revision.id,filled.id);assert.equal(s.status().conflicts,0);s.reconcileConflicts();
 assert.equal(s.get(note).heads.length,1);assert.equal(s.get(note).firstEditedAt,filled.timestamp);assert.equal(s.get(note).revision.deviceId,filled.deviceId);assert.equal(s.get(note).revision.payload.blocks[0].text,'保留有内容的一方');
});
test('identical text, checks and images ignore generated block IDs and trailing empty editor blocks',()=>{
 const s=store(),image=s.addAsset(png),body=[block('同一份正文'),{id:uuid(),kind:'check',text:'读书',checked:true},{id:uuid(),kind:'image',assetId:image.assetId,caption:'原图'}];
 s.save({entityId:note,parents:[],payload:{blocks:body}});s.save({entityId:note,parents:[],payload:{blocks:[...body.map(b=>({...b,id:uuid()})),block('')]}});
 assert.equal(s.get(note).conflict,false);assert.equal(s.get(note).conflictHeads.length,1);s.reconcileConflicts();assert.equal(s.get(note).heads.length,1);
 assert.deepEqual(new Store(s.root).readAsset(image.assetId),png);
});
test('real conflicts expose only distinct nonempty choices, with every raw branch kept for resolution',()=>{
 const s=store();for(const text of ['', '电脑正文','手机正文','电脑正文'])write(s,text,note,[]);
 const r=s.get(note);assert.equal(r.heads.length,4);assert.equal(r.conflictHeads.length,2);assert.equal(r.conflict,true);assert.equal(s.reconcileConflicts().length,0);
 assert.deepEqual(new Set(r.conflictHeads.map(x=>x.payload.blocks[0].text)),new Set(['电脑正文','手机正文']));
 s.save({entityId:note,parents:r.heads.map(x=>x.id),payload:r.conflictHeads[0].payload});assert.equal(s.get(note).heads.length,1);assert.equal(s.status().conflicts,0);assert.equal(s.all(note).length,5);
});
test('a photo alone or a checked blank item counts as content, while changed checks and captions require comparison',()=>{
 const s=store(),asset=s.addAsset(png);write(s,'',note,[]);s.save({entityId:note,parents:[],payload:{blocks:[{id:uuid(),kind:'image',assetId:asset.assetId,caption:''}]}});s.reconcileConflicts();assert.equal(s.get(note).revision.payload.blocks[0].kind,'image');
 const check='note:2026-10-15:intent';write(s,'',check,[]);s.save({entityId:check,parents:[],payload:{blocks:[{id:uuid(),kind:'check',text:'',checked:true}]}});assert.equal(s.get(check).conflict,false);assert.equal(s.get(check).revision.payload.blocks[0].checked,true);
 for(const checked of [false,true])s.save({entityId:'note:2026-10-16:intent',parents:[],payload:{blocks:[{id:uuid(),kind:'check',text:'阅读',checked}]}});assert.equal(s.get('note:2026-10-16:intent').conflict,true);
 s.save({entityId:note,parents:[],payload:{blocks:[{id:uuid(),kind:'image',assetId:asset.assetId,caption:'新说明'}]}});assert.equal(s.get(note).conflict,true);
});
test('automatic merges are deterministic across devices and preserve all original revisions in backups',()=>{
 const a=store(),b=store();write(a,'',note,[]);write(a,'相同内容',note,[]);write(a,'相同内容',note,[]);for(const r of a.revisions.values())b.importRevision(r);
 const ar=a.reconcileConflicts()[0],br=b.reconcileConflicts()[0];assert.deepEqual(ar,br);a.importRevision(br);assert.equal(a.get(note).heads.length,1);assert.equal(a.revisions.size,4);validateGraph([...a.revisions.values()]);
 const restored=store();restored.restoreBackup(a.backupBuffer());assert.equal(restored.get(note).conflict,false);assert.equal(restored.get(note).revision.payload.blocks[0].text,'相同内容');for(const r of a.revisions.values())assert(restored.revisions.has(r.id));
});
test('more than one hundred empty branches merge in bounded parent batches without losing the graph',()=>{
 const s=store(),template=write(s,'',note,[]);for(let i=0;i<104;i++)s.importRevision({...template,id:uuid()});
 s.reconcileConflicts();assert.equal(s.get(note).heads.length,1);assert.equal(s.get(note).conflict,false);assert([...s.revisions.values()].every(r=>r.parents.length<=100));validateGraph([...s.revisions.values()]);
 const b=store();for(let i=0;i<101;i++)b.importRevision({...template,id:uuid(),deviceId:b.profile.deviceId,timestamp:'2020-01-01T00:00:00.000Z'});b.importRevision({...template,id:uuid(),deviceId:b.profile.deviceId,timestamp:'2021-01-01T00:00:00.000Z',payload:{blocks:[block('首次非空正文')]}});b.reconcileConflicts();assert.equal(b.get(note).firstEditedAt,'2021-01-01T00:00:00.000Z');
});
test('identical course plans merge without changing their schedule or effective date; named empty-content plans remain data',()=>{
 const s=store(),id='plan:'+uuid(),payload={kind:'course',title:'英语课',time:'',content:'',lessons:[{id:uuid(),title:'第一课',date:'2026-10-14',time:'',content:'听力'}]};
 const first=s.save({entityId:id,parents:[],payload}).revision;s.importRevision({...first,id:uuid(),payload:{...first.payload,lessons:first.payload.lessons.map(l=>({...l,id:uuid()}))}});
 assert.equal(s.get(id).conflict,false);s.reconcileConflicts();assert.equal(s.get(id).revision.effectiveDate,'2026-10-14');assert.equal(s.schedule('2026-10-14')[0].title,'英语课 · 第一课');
 const once='plan:'+uuid();s.save({entityId:once,parents:[],payload:{kind:'once',title:'仅名称的安排',date:localDate(),content:'',time:''}});s.save({entityId:once,parents:[],deleted:true,payload:null});assert.equal(s.get(once).conflict,false);assert.equal(s.get(once).revision.payload.title,'仅名称的安排');
});
test('synchronized empty and equal branches converge without recurring conflicts, including simultaneous automatic merges',async()=>{
 const dav=await server();try{const a=store(),b=store(),sa=new Sync(a),sb=new Sync(b);write(a,'',note,[]);write(b,'有内容的正文',note,[]);write(a,'一样的打算','note:2026-10-15:intent',[]);write(b,'一样的打算','note:2026-10-15:intent',[]);
 await Promise.all([sa.run(dav.config),sb.run(dav.config)]);for(let i=0;i<3;i++){await sa.run(dav.config);await sb.run(dav.config);}
 for(const s of [a,b]){assert.equal(s.get(note).heads.length,1);assert.equal(s.get(note).revision.payload.blocks[0].text,'有内容的正文');assert.equal(s.status().conflicts,0);assert.equal(s.status().pendingRecords,0);assert.equal(s.get('note:2026-10-15:intent').heads.length,1);}
 assert.equal(a.get(note).revision.id,b.get(note).revision.id);const size=a.revisions.size;await sa.run(dav.config);await sb.run(dav.config);assert.equal(a.revisions.size,size);
 }finally{await dav.close();}
});
test('concurrent plan deletions are empty and merge without prompting',()=>{
  const s=store(),id='plan:'+uuid(),base=s.save({entityId:id,parents:[],payload:{kind:'once',title:'临时安排',date:localDate(),time:'',content:''}}).revision;
  s.save({entityId:id,parents:[base.id],deleted:true,payload:null});s.save({entityId:id,parents:[base.id],deleted:true,payload:null});assert.equal(s.plans().length,0);assert.equal(s.get(id).conflict,false);s.reconcileConflicts();assert.equal(s.get(id).heads.length,1);
  s.save({entityId:id,parents:s.get(id).heads.map(r=>r.id),deleted:true,payload:null});assert.equal(s.plans().length,0);assert.equal(s.status().conflicts,0);
});
test('weekday-specific plans and dated courses do not shift after a missed lesson',()=>{
  const s=store(),week='plan:'+uuid();s.save({entityId:week,parents:[],payload:{kind:'weekly',title:'训练',startDate:'2026-10-01',endDate:'',time:'18:30',content:'',weekdays:[1,3],weekContent:{1:'深蹲',3:'俯卧撑'}}});
  assert.equal(s.schedule('2026-10-12')[0].content,'深蹲');assert.equal(s.schedule('2026-10-14')[0].content,'俯卧撑');assert.equal(s.schedule('2026-10-13').length,0);
  s.save({entityId:'plan:'+uuid(),parents:[],payload:{kind:'course',title:'英语',time:'',content:'',lessons:[{id:uuid(),date:'2026-10-13',title:'第2课',time:'',content:'请求解释'},{id:uuid(),date:'2026-10-14',title:'第3课',time:'',content:'询问时间'}]}});
  assert(s.schedule('2026-10-14').some(x=>x.title==='英语 · 第3课'));assert(!s.schedule('2026-10-14').some(x=>x.title==='英语 · 第2课'));
});
test('complete ZIP includes original images and excludes passwords; restoration creates new history',()=>{
  const s=store(),asset=s.addAsset(png);s.save({entityId:note,parents:[],payload:{blocks:[block('旧日记'),{id:uuid(),kind:'image',assetId:asset.assetId,caption:''}]}});const buf=s.backupBuffer();const zip=readZip(buf);assert(zip.has('assets/'+asset.assetId+'.bin'));assert(![...zip.keys()].some(x=>x.includes('connection')));write(s,'后来修改');const result=s.restoreBackup(buf);assert.equal(result.records,1);assert.equal(s.get(note).revision.payload.blocks[0].text,'旧日记');assert(s.all(note).some(r=>r.payload?.blocks[0]?.text==='后来修改'));assert(fs.existsSync(result.before));
});
test('missing image prevents reporting a complete backup',()=>{const s=store();s.save({entityId:note,parents:[],payload:{blocks:[{id:uuid(),kind:'image',assetId:'a'.repeat(64),caption:''}]}});assert.throws(()=>s.backupBuffer(),/尚未下载/);});
test('invalid backup is rejected before changing current data',()=>{
  const s=store();write(s,'保留原文');const before=s.revisions.size;const buf=makeZip([['manifest.json',Buffer.from(JSON.stringify({format:'riye-backup',schema:1}))],['../../outside.txt',Buffer.from('bad')]]);assert.throws(()=>s.restoreBackup(buf));assert.equal(s.revisions.size,before);assert.equal(s.get(note).revision.payload.blocks[0].text,'保留原文');
});
test('revision graphs reject missing, cross-record or circular parents',()=>{assert.throws(()=>validateGraph([{id:'a',entityId:'n',parents:['b']},{id:'b',entityId:'n',parents:['a']}]));assert.throws(()=>validateGraph([{id:'a',entityId:'n',parents:['missing']}]));});
test('WebDAV XML parser handles prefixes and encoded Chinese directory',()=>{const url='http://localhost/%E6%97%A5%E9%A1%B5%20%E6%B5%8B%E8%AF%95/revisions/';const xml='<x:multistatus><x:response><x:href>'+url+'abc.json</x:href></x:response><x:response><x:href>https://other.test/file.json</x:href></x:response></x:multistatus>';assert.deepEqual(listing(xml,url),['abc.json']);});
test('two offline devices exchange independent changes and preserve concurrent same-note versions',async()=>{
  const dav=await server();try{const a=store(),b=store(),sa=new Sync(a),sb=new Sync(b);const original=write(a,'共同原文');await sa.run(dav.config);await sb.run(dav.config);
    assert.equal(b.get(note).revision.payload.blocks[0].text,'共同原文');write(a,'电脑A修改',note,[original.id]);write(b,'电脑B修改',note,[original.id]);
    write(a,'明天办事','note:2026-10-15:intent');write(b,'另一份日记','note:2026-10-16:diary');await Promise.all([sa.run(dav.config),sb.run(dav.config)]);await sa.run(dav.config);await sb.run(dav.config);
    for(const s of [a,b]){assert.equal(s.get(note).heads.length,2);assert.equal(s.get('note:2026-10-15:intent').revision.payload.blocks[0].text,'明天办事');assert.equal(s.get('note:2026-10-16:diary').revision.payload.blocks[0].text,'另一份日记');assert.equal(s.status().pendingRecords,0);}
  }finally{await dav.close();}
});
test('interrupted photo upload retries without losing local data or prematurely completing sync',async()=>{
  const dav=await server();try{const a=store(),b=store(),asset=a.addAsset(png);a.save({entityId:note,parents:[],payload:{blocks:[{id:uuid(),kind:'image',assetId:asset.assetId,caption:'原图'}]}});dav.control.failAssetOnce=true;const sync=new Sync(a);await assert.rejects(sync.run(dav.config));assert(a.hasAsset(asset.assetId));assert(a.status().pendingPhotos>0);assert.equal(a.status().lastSync,null);await sync.run(dav.config);await new Sync(b).run(dav.config);assert.deepEqual(b.readAsset(asset.assetId),png);assert.equal(a.status().pendingPhotos,0);
  }finally{await dav.close();}
});
test('wrong credentials leave offline data untouched',async()=>{const dav=await server();try{const s=store();write(s,'离线原文');await assert.rejects(new Sync(s).run({...dav.config,password:'wrong'}),/账号或密码/);assert.equal(s.get(note).revision.payload.blocks[0].text,'离线原文');}finally{await dav.close();}});
test('existing directories can be used even when the server forbids recreating them',async()=>{const dav=await server();try{const a=store(),b=store();write(a,'已有目录中的日记');await new Sync(a).run(dav.config);dav.control.denyExistingMkcol=true;await new Sync(b).run(dav.config);assert.equal(b.get(note).revision.payload.blocks[0].text,'已有目录中的日记');}finally{await dav.close();}});

test('a restarted client repairs a partial photo or JSON left by a failed PUT',async()=>{
 for(const kind of ['assets','revisions']){const dav=await server();try{
  const a=store(),b=store(),asset=a.addAsset(png);a.save({entityId:note,parents:[],payload:{blocks:[block('文字与原图'),{id:uuid(),kind:'image',assetId:asset.assetId,caption:''}]}});
  dav.control.partialOnce=kind;await assert.rejects(new Sync(a).run(dav.config));assert.equal(a.status().lastSync,null);assert(a.status().pendingRecords>0);
  const restarted=new Store(a.root);await new Sync(restarted).run(dav.config);await new Sync(b).run(dav.config);assert.deepEqual(b.readAsset(asset.assetId),png);assert.equal(b.get(note).revision.payload.blocks[0].text,'文字与原图');assert.equal(restarted.status().pendingRecords,0);
 }finally{await dav.close();}}
});
test('a server returning success for a truncated photo is detected and retried',async()=>{const dav=await server();try{
 const a=store(),asset=a.addAsset(png);write(a,'不能误报完成');dav.control.truncateSuccessOnce=true;await assert.rejects(new Sync(a).run(dav.config),/校验失败/);assert.equal(a.status().lastSync,null);assert(a.status().pendingPhotos>0);await new Sync(a).run(dav.config);assert.equal(a.status().pendingPhotos,0);
}finally{await dav.close();}});
test('retry never overwrites a valid remote revision with different content',async()=>{const dav=await server();try{
 const a=store(),r=write(a,'本地原文');await new Sync(a).run(dav.config);const file=[...dav.files.keys()].find(n=>n.endsWith(r.id+'.json'));const changed=JSON.parse(dav.files.get(file));changed.payload.blocks[0].text='不同的有效远程内容';dav.files.set(file,Buffer.from(JSON.stringify(changed)));a.updateRemote({revisions:[]});await assert.rejects(new Sync(a).run(dav.config),/校验失败/);assert.equal(JSON.parse(dav.files.get(file)).payload.blocks[0].text,'不同的有效远程内容');assert.equal(a.get(note).revision.payload.blocks[0].text,'本地原文');
}finally{await dav.close();}});

test('calendar status excludes empty drafts and distinguishes intentions, text and photo diaries',()=>{
 const s=store(),date='2026-10-15',intent='note:'+date+':intent',diary='note:'+date+':diary';write(s,'  ',intent);write(s,'',diary);
 assert.equal(s.history()[0].hasIntent,false);assert.equal(s.history()[0].hasDiary,false);assert.equal(s.get(diary).firstEditedAt,null);
 write(s,'今天学英语',intent);assert.equal(s.history()[0].hasIntent,true);assert.equal(s.history()[0].hasDiary,false);
 const a=s.addAsset(png);s.save({entityId:diary,parents:s.get(diary).heads.map(r=>r.id),payload:{blocks:[{id:uuid(),kind:'image',assetId:a.assetId,caption:''}]}});assert.equal(s.history()[0].hasDiary,true);
});
test('first meaningful diary edit time survives later edits, restart and backup restoration',()=>{
 const s=store(),started=new Date(Date.now()-15000).toISOString();write(s,'');s.save({entityId:note,parents:s.get(note).heads.map(r=>r.id),firstEditedAt:started,payload:{blocks:[block('第一句话')]}});
 write(s,'继续补充');assert.equal(s.get(note).firstEditedAt,started);assert.equal(new Store(s.root).get(note).firstEditedAt,started);
 const restored=store();restored.restoreBackup(s.backupBuffer());assert.equal(restored.get(note).firstEditedAt,started);
});
test('device names persist locally and backup preserves the source label without adopting its device identity',()=>{
 const s=store();s.setDeviceName(' 公司电脑 ');const id=s.profile.deviceId;assert.equal(new Store(s.root).status().deviceName,'公司电脑');write(s,'工作记录');
 const other=store(),ownId=other.profile.deviceId;other.restoreBackup(s.backupBuffer());assert.equal(other.status().devices[id],'公司电脑');assert.equal(other.profile.deviceId,ownId);assert.notEqual(id,ownId);assert.throws(()=>s.setDeviceName('坏\n名称'),/设备名称/);
});
test('day deletion removes both notes, keeps plans and history, and rejects stale confirmation',()=>{
 const s=store(),date='2026-10-14',intent='note:'+date+':intent';write(s,'打算',intent);write(s,'日记');s.save({entityId:'plan:'+uuid(),parents:[],payload:{kind:'once',date,title:'固定安排',time:'',content:'内容'}});
 const data=s.getDay(date),request={date,parents:{intent:data.intent.heads.map(r=>r.id),diary:data.diary.heads.map(r=>r.id)}};write(s,'新修改');assert.throws(()=>s.deleteDay(request),/刚刚变化/);assert.equal(s.get(intent).revision.deleted,false);
 request.parents.diary=s.get(note).heads.map(r=>r.id);assert.equal(s.deleteDay(request).removed,2);assert.equal(s.history()[0].deleted,true);assert.equal(s.getDay(date).schedule.length,1);assert(s.all(note).some(r=>!r.deleted&&r.payload.blocks[0].text==='日记'));
 const old=s.all(note).find(r=>!r.deleted);s.save({entityId:note,parents:s.get(note).heads.map(r=>r.id),payload:old.payload});assert.equal(s.history()[0].hasDiary,true);
});
test('causal deletions propagate while a concurrent nonempty offline edit is automatically retained',async()=>{
 const dav=await server();try{const a=store(),b=store();write(a,'共同原文');await new Sync(a).run(dav.config);await new Sync(b).run(dav.config);const d=a.getDay('2026-10-14');a.deleteDay({date:d.date,parents:{intent:[],diary:d.diary.heads.map(r=>r.id)}});await new Sync(a).run(dav.config);await new Sync(b).run(dav.config);assert.equal(b.history()[0].deleted,true);
 const original=b.all(note).find(r=>!r.deleted);b.save({entityId:note,parents:[original.id],payload:{blocks:[block('另一台离线的新内容')]}});await new Sync(b).run(dav.config);await new Sync(a).run(dav.config);assert.equal(a.get(note).conflict,false);assert(a.all(note).some(r=>r.deleted));assert.equal(a.get(note).revision.payload.blocks[0].text,'另一台离线的新内容');
 }finally{await dav.close();}
});
test('simultaneous sync receives both peers changes and names before reporting complete',async()=>{
 const dav=await server();try{const a=store(),b=store();a.setDeviceName('公司电脑');b.setDeviceName('手机');write(a,'电脑打算','note:2026-10-15:intent');write(b,'手机日记','note:2026-10-15:diary');
 let count=0,release;const barrier=new Promise(r=>release=r);dav.control.afterList=async()=>{if(++count<=2){if(count===2)release();await barrier;}};
 const results=await Promise.all([new Sync(a).run(dav.config),new Sync(b).run(dav.config)]);for(const s of [a,b]){assert.equal(s.get('note:2026-10-15:intent').revision.payload.blocks[0].text,'电脑打算');assert.equal(s.get('note:2026-10-15:diary').revision.payload.blocks[0].text,'手机日记');assert.equal(s.status().devices[a.profile.deviceId],'公司电脑');assert.equal(s.status().devices[b.profile.deviceId],'手机');}for(const result of results){assert.equal(result.pendingDownloads,0);assert.equal(result.pendingRecords,0);assert.equal(result.pendingDevice,false);}
 }finally{await dav.close();}
});
test('restarted uploads publish causal parents before children even if filenames sort backwards',async()=>{
 const dav=await server();try{const s=store(),base=write(s,'父版本'),child=write(s,'子版本');const raws=[{...base,id:'ffffffff-ffff-ffff-ffff-ffffffffffff'},{...child,id:'00000000-0000-0000-0000-000000000000',parents:['ffffffff-ffff-ffff-ffff-ffffffffffff']}];const x=store();for(const r of raws)x.importRevision(r);const reopened=new Store(x.root);assert.equal([...reopened.revisions.keys()][0],raws[1].id);
 dav.control.afterPut=async(p,data)=>{if(p.includes('/revisions/')){const r=JSON.parse(data);for(const id of r.parents)assert(dav.files.has(p.slice(0,p.lastIndexOf('/')+1)+id+'.json'),'parent must reach server before child');}};
 await new Sync(reopened).run(dav.config);
 }finally{await dav.close();}
});
test('a photo and child note added mid-sync remain queued together until their next upload',async()=>{
 const dav=await server();try{const s=store(),photo=s.addAsset(png);s.save({entityId:note,parents:[],payload:{blocks:[{id:uuid(),kind:'image',assetId:photo.assetId,caption:''}]}});let added=false,later;
 dav.control.afterPut=async p=>{if(!added&&p.includes('/assets/')){added=true;const second=s.addAsset(Buffer.concat([png,Buffer.from('new image')]));later=s.save({entityId:note,parents:s.get(note).heads.map(r=>r.id),payload:{blocks:[{id:uuid(),kind:'image',assetId:second.assetId,caption:'同步中新加入'}]}}).revision;}};
 const result=await new Sync(s).run(dav.config);assert.equal(result.pendingRecords,1);assert.equal(result.pendingPhotos,1);assert.equal(result.lastSync,null);assert(![...dav.files.keys()].some(p=>p.endsWith(later.id+'.json')));await new Sync(s).run(dav.config);const peer=store();await new Sync(peer).run(dav.config);assert.equal(peer.get(note).revision.payload.blocks[0].caption,'同步中新加入');assert.equal(peer.status().missingPhotos,0);
 }finally{await dav.close();}
});
test('continuous peer writes leave an explicit download count rather than false sync success',async()=>{
 const dav=await server();try{const s=store(),peer=store();let count=0;dav.control.afterList=async()=>{const r=write(peer,'持续输入 '+(++count),'note:2026-10-16:intent');const path='/'+encodeURIComponent('日页 测试')+'/revisions/'+r.id+'.json';dav.files.set(path,Buffer.from(JSON.stringify(r)));};
 const result=await new Sync(s).run(dav.config);assert(result.pendingDownloads>0);assert.equal(result.lastSync,null);assert([...dav.files.keys()].filter(p=>p.includes('/revisions/')).length>s.revisions.size);
 }finally{await dav.close();}
});
