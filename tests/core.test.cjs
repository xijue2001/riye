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
      res.writeHead(207,{'Content-Type':'application/xml'});res.end(xml+'</D:multistatus>');return;
    }
    if(req.method==='PUT'){
      if(control.failAssetOnce&&p.includes('/assets/')){control.failAssetOnce=false;res.writeHead(503);res.end();return;}
      if(files.has(p)&&req.headers['if-none-match']==='*'){res.writeHead(412);res.end();return;}
      const chunks=[];for await(const x of req)chunks.push(x);let data=Buffer.concat(chunks);if(control.partialOnce&&p.includes('/'+control.partialOnce+'/')){control.partialOnce=null;files.set(p,data.subarray(0,7));res.writeHead(503);res.end();return;}if(control.truncateSuccessOnce&&p.includes('/assets/')){control.truncateSuccessOnce=false;data=data.subarray(0,7);}files.set(p,data);res.writeHead(201);res.end();return;
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
test('concurrent plan deletions remain available for explicit conflict resolution',()=>{
  const s=store(),id='plan:'+uuid(),base=s.save({entityId:id,parents:[],payload:{kind:'once',title:'临时安排',date:localDate(),time:'',content:''}}).revision;
  s.save({entityId:id,parents:[base.id],deleted:true,payload:null});s.save({entityId:id,parents:[base.id],deleted:true,payload:null});assert.equal(s.plans().length,1);assert.equal(s.plans()[0].conflict,true);
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
