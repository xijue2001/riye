'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {Store}=require('../core/store.cjs'),{Sync,Dav,fileListing}=require('../core/dav.cjs'),R=require('../core/retention.cjs'),{uuid,validateGraph}=require('../core/model.cjs');
const roots=[],note='note:2026-09-01:diary',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII=','base64');
const make=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-retention-'));roots.push(root);const s=new Store(root);s.autoBackup=()=>{};return s;};
test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
function write(s,text,date,manual=true,parents=s.get(note).heads.map(r=>r.id)){
 const r=s.importRevision({schema:1,id:uuid(),entityId:note,deviceId:s.profile.deviceId,parents,timestamp:date,effectiveDate:'2026-09-01',deleted:false,payload:{blocks:[{id:uuid(),kind:'text',text}]}});
 s.importCheckpoint({format:'riye-checkpoint',schema:1,id:uuid(),entityId:note,revisionId:r.id,deviceId:r.deviceId,kind:manual?'save':'start',timestamp:date});return r;
}
const {server}=require('./helpers/mock-dav.cjs');

test('30 days uses save time, preserves the boundary, current content, conflicts and first edit time',()=>{
 const s=make(),now=Date.parse('2026-11-06T00:00:00Z');const old=write(s,'过期','2026-09-01T00:00:00Z'),edge=write(s,'边界','2026-10-07T00:00:00Z'),recent=write(s,'近期','2026-11-01T00:00:00Z'),head=write(s,'当前','2026-11-03T00:00:00Z'),branch=write(s,'未解决的分支','2026-09-02T00:00:00Z',true,[old.id]);
 const p=R.plan(s,{mode:'days',days:30},now);assert.deepEqual(p.retired.map(r=>r.id),[old.id]);for(const r of [edge,recent,head,branch])assert(!p.retired.some(x=>x.id===r.id));
 s.updateRemote({checkpoints:s.checkpointList().map(c=>c.id)});s.importRetention(R.eventFor(p));assert(s.get(note).conflict);assert.equal(s.get(note).firstEditedAt,old.timestamp);validateGraph(s.graph());assert.equal(new Store(s.root).get(note).firstEditedAt,old.timestamp);
});
test('per-entry count cap compacts drafts as well as visible history, leaving immutable bodies and photos intact',()=>{
 const s=make();for(let i=0;i<8;i++)write(s,'第'+i+'份',new Date(Date.parse('2026-11-01')+i*1000).toISOString(),i%2===0);
 const photo=s.addAsset(png),before=new Map(s.revisions),p=R.plan(s,{mode:'count',count:2});assert(p.retired.length>=4);s.updateRemote({checkpoints:s.checkpointList().map(c=>c.id)});s.importRetention(R.eventFor(p));s.pruneFiles();assert.equal(s.versions(note).filter(r=>!r.current).length,2);assert(s.hasAsset(photo.assetId));for(const r of s.revisions.values())assert.deepEqual(r,before.get(r.id));assert.equal(new Store(s.root).status().warnings.length,0);
});
test('retired causal chains handle deep drafts and reject cross-entry references and cycles',()=>{
 const s=make(),root=write(s,'根','2026-09-01T00:00:00Z');const retired=new Map();let parent=root.id;for(let i=0;i<12000;i++){const id=uuid();retired.set(id,{id,entityId:note,parents:[parent]});parent=id;}
 const child={...root,id:uuid(),parents:[parent]};assert.deepEqual(R.graph([root,child],retired)[1].parents,[root.id]);retired.get(parent).entityId='note:2026-09-01:intent';assert.throws(()=>R.graph([child],retired),/另一篇/);
 const a=uuid(),b=uuid();assert.throws(()=>R.graph([{...child,parents:[a]}],new Map([[a,{entityId:note,parents:[b]}],[b,{entityId:note,parents:[a]}]])),/损坏/);
});
test('usage follows only descendants, counts server sizes, and uses no write or diary-body reads',async()=>{
 const dav=await server();try{const s=make();write(s,'虚构记录','2026-11-01T00:00:00Z');await new Sync(s).run(dav.config);dav.requests.length=0;const result=await new Dav(dav.config).usage();assert.equal(result.files,dav.files.size);assert.equal(result.bytes,[...dav.files.values()].reduce((n,b)=>n+b.length,0));assert.equal(result.unknown,0);assert(dav.requests.every(r=>r.method==='PROPFIND'||r.method==='GET'&&r.path==='/riye/info.json'));
 }finally{await dav.close();}
});
test('DAV sizes reject failed properties and external, sibling or encoded traversal hrefs',()=>{
 const response=(href,props,status='200 OK')=>`<x:response><x:href>${href}</x:href><x:propstat><x:prop>${props}</x:prop><x:status>HTTP/1.1 ${status}</x:status></x:propstat></x:response>`;
 const xml='<x:multistatus xmlns:x="DAV:">'+response('/riye/a','<x:getcontentlength>123</x:getcontentlength>')+response('http://evil.test/riye/b','<x:getcontentlength>999</x:getcontentlength>')+response('/riye/a%2Fb','')+response('/riye/../c','')+response('/riye/unknown','<x:getcontentlength>999</x:getcontentlength>','404 Not Found')+'</x:multistatus>';
 assert.deepEqual(fileListing(xml,'http://localhost/riye/'),[{name:'a',directory:false,bytes:123},{name:'unknown',directory:false,bytes:null}]);
});
test('preview is nondestructive; cleanup reduces real cloud bytes and offline peers never resurrect retired bodies',async()=>{
 const dav=await server();try{const a=make(),b=make();const old=write(a,'旧历史','2026-01-01T00:00:00Z');write(a,'中间草稿','2026-01-02T00:00:00Z',false);const current=write(a,'当前正文','2026-01-03T00:00:00Z');a.addAsset(png);
 const sync=new Sync(a);await sync.run(dav.config);await new Sync(b).run(dav.config);const before=await new Dav(dav.config).usage(),p=await sync.run(dav.config,{preview:{mode:'days',days:30}});assert.equal(a.revisions.size,3);assert.equal(JSON.parse(dav.files.get('/riye/info.json')).schema,1);
 const result=await sync.run(dav.config,{apply:{policy:p.policy,token:p.token}});assert(result.removed>0);assert.equal(a.get(note).revision.id,current.id);assert.equal(a.revisions.size,1);assert.equal(JSON.parse(dav.files.get('/riye/info.json')).schema,2);assert((await new Dav(dav.config).usage()).bytes<before.bytes);
 write(b,'离线新修改',new Date().toISOString(),true,[old.id]);await new Sync(b).run(dav.config);await sync.run(dav.config);assert(a.get(note).conflict);assert(!dav.files.has('/riye/revisions/'+old.id+'.json'));assert.equal(a.get(note).firstEditedAt,old.timestamp);
 const fresh=make();await new Sync(fresh).run(dav.config);assert(fresh.get(note).conflict);assert.equal(fresh.revisions.size,a.revisions.size);validateGraph(fresh.graph());
 }finally{await dav.close();}
});
test('interrupted deletion is retryable and stale preview cannot remove newly saved history',async()=>{
 const dav=await server();try{const a=make();write(a,'旧','2026-01-01T00:00:00Z');write(a,'新','2026-01-02T00:00:00Z');const sync=new Sync(a),p=await sync.run(dav.config,{preview:{mode:'days',days:30}});write(a,'后来保存',new Date().toISOString());await assert.rejects(sync.run(dav.config,{apply:{policy:p.policy,token:p.token}}),/重新预览/);assert.equal(JSON.parse(dav.files.get('/riye/info.json')).schema,1);
 const next=await sync.run(dav.config,{preview:p.policy});dav.control.deleteFail=true;await assert.rejects(sync.run(dav.config,{apply:{policy:next.policy,token:next.token}}));assert(a.retired.size>0);await new Sync(new Store(a.root)).run(dav.config);const fresh=make();await new Sync(fresh).run(dav.config);assert.equal(fresh.get(note).revision.payload.blocks[0].text,'后来保存');assert.equal(fresh.status().pendingRecords,0);
 }finally{await dav.close();}
});
test('compacted backup restores graph, history and first edit time and can initialize a new NAS',async()=>{
 const a=make();write(a,'旧','2026-01-01T00:00:00Z');write(a,'当前','2026-01-02T00:00:00Z');a.updateRemote({checkpoints:a.checkpointList().map(c=>c.id)});a.importRetention(R.eventFor(R.plan(a,{mode:'days',days:30})));a.pruneFiles();const b=make();b.restoreBackup(a.backupBuffer());assert.equal(b.get(note).revision.payload.blocks[0].text,'当前');assert.equal(b.get(note).firstEditedAt,'2026-01-01T00:00:00Z');validateGraph(b.graph());
 const dav=await server();try{await new Sync(b).run(dav.config);const fresh=make();await new Sync(fresh).run(dav.config);assert.equal(fresh.get(note).revision.payload.blocks[0].text,'当前');assert.equal(fresh.get(note).firstEditedAt,'2026-01-01T00:00:00Z');}finally{await dav.close();}
});
test('a partial retirement PUT deletes nothing and is repaired from a durable intent on restart',async()=>{
 const dav=await server();try{const a=make();write(a,'过期','2026-01-01T00:00:00Z');write(a,'当前','2026-01-02T00:00:00Z');const sync=new Sync(a),p=await sync.run(dav.config,{preview:{mode:'days',days:30}});dav.control.partialEvent=true;
 await assert.rejects(sync.run(dav.config,{apply:{policy:p.policy,token:p.token}}));assert.equal(a.revisions.size,2);assert.equal(a.pendingRetentions.size,1);assert.equal(dav.requests.filter(r=>r.method==='DELETE').length,0);
 const restarted=new Store(a.root);await new Sync(restarted).run(dav.config);assert.equal(restarted.pendingRetentions.size,0);assert.equal(restarted.revisions.size,1);const fresh=make();await new Sync(fresh).run(dav.config);assert.equal(fresh.get(note).revision.payload.blocks[0].text,'当前');
 }finally{await dav.close();}
});
test('an offline explicit save of retired content is rebased instead of discarded',async()=>{
 const dav=await server();try{const a=make(),b=make(),old=write(a,'离线时看到的内容','2026-01-01T00:00:00Z',false),sync=new Sync(a);await sync.run(dav.config);await new Sync(b).run(dav.config);write(a,'另一端的当前正文','2026-01-02T00:00:00Z');const p=await sync.run(dav.config,{preview:{mode:'days',days:30}});await sync.run(dav.config,{apply:{policy:p.policy,token:p.token}});
 b.checkpoint({entityId:note,revisionId:old.id});await new Sync(b).run(dav.config);assert(b.get(note).conflict);assert(b.versions(note).some(r=>r.saved&&r.payload.blocks[0].text==='离线时看到的内容'));await sync.run(dav.config);assert(a.get(note).conflict);
 }finally{await dav.close();}
});
test('typing during cleanup stays queued and the last cloud current revision remains available',async()=>{
 const dav=await server();try{const a=make(),sync=new Sync(a);write(a,'旧','2026-01-01T00:00:00Z');const last=write(a,'已上传的当前正文','2026-01-02T00:00:00Z');const p=await sync.run(dav.config,{preview:{mode:'days',days:30}});let late;
 dav.control.afterPut=async file=>{if(!late&&file.includes('/retentions/'))late=write(a,'清理期间继续写',new Date().toISOString());};const result=await sync.run(dav.config,{apply:{policy:p.policy,token:p.token}});assert(result.status.pendingRecords>=2);assert(!dav.files.has('/riye/revisions/'+late.id+'.json'));assert(dav.files.has('/riye/revisions/'+last.id+'.json'));
 dav.control.afterPut=null;await sync.run(dav.config);const fresh=make();await new Sync(fresh).run(dav.config);assert.equal(fresh.get(note).revision.payload.blocks[0].text,'清理期间继续写');
 }finally{await dav.close();}
});
