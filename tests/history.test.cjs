'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../core/store.cjs');
const {uuid,validateGraph}=require('../core/model.cjs');
const {onlyAdds}=require('../core/history.cjs');
const roots=[];test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const note='note:2026-10-18:diary',text=value=>({id:uuid(),kind:'text',text:value});
function store(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-history-'));roots.push(root);return new Store(root);}
function save(s,blocks,extra={}){return s.save({entityId:note,parents:s.get(note).heads.map(r=>r.id),payload:{blocks},...extra}).revision;}
function raw(s,blocks,parents=[],extra={}){return s.importRevision({schema:1,id:uuid(),deviceId:s.profile.deviceId,entityId:note,parents,timestamp:new Date().toISOString(),effectiveDate:'2026-10-18',deleted:false,payload:{blocks},...extra});}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII=','base64');
test('unchanged saves reuse the same revision, ignore IDs and empty placeholders, and validate input',()=>{
 const s=store(),first=save(s,[text('虚构测试记录')]);for(let i=0;i<12;i++)assert.equal(save(s,[text('虚构测试记录'),text('  ')]).id,first.id);
 assert.equal(s.all(note).length,1);assert.equal(s.versions(note).length,1);assert(s.versions(note)[0].current);
 assert.throws(()=>save(s,[{id:uuid(),kind:'invalid',text:'x'}]));
 const other=raw(s,[text('另一台设备的修改')],[]);const resolved=save(s,[text('另一台设备的修改')]);assert.notEqual(resolved.id,other.id);assert.equal(s.get(note).heads.length,1);
});
test('continuous additions leave only current content; an edit preserves the last complete draft',()=>{
 const s=store(),a=save(s,[text('早上散步')]);save(s,[text('早上散步，买菜')]);const before=save(s,[text('早上散步，买菜'),text('晚上读书')]);
 assert.equal(s.versions(note).length,1);
 save(s,[text('早上跑步，买菜'),text('晚上读书')]);save(s,[text('早上跑步，买菜'),text('晚上读书，再记一句')]);
 const shown=s.versions(note);assert.equal(shown.length,2);assert(shown.some(r=>r.id===before.id));assert(!shown.some(r=>r.id===a.id));assert.equal(shown.filter(r=>r.current).length,1);
 assert.equal(new Store(s.root).versions(note).length,2);assert.equal(s.all(note).length,5);
});
test('inserted text, paragraph splits, new checks and inline photos are additions',()=>{
 const s=store(),image=s.addAsset(png),revision=blocks=>({entityId:note,deleted:false,payload:{blocks}});
 const before=revision([text('甲乙丙')]),after=revision([text('前甲'),{id:uuid(),kind:'image',assetId:image.assetId,caption:'照片'},text('乙新增丙后')]);
 assert(onlyAdds(before,after));assert(!onlyAdds(after,before));
 const check={id:uuid(),kind:'check',text:'事项',checked:false};assert(onlyAdds(revision([text('甲乙')]),revision([text('甲'),check,text('乙')])));
 assert(onlyAdds(revision([{...check,text:'读书'}]),revision([{...check,text:'晚上读书一会儿'}])));
 assert(!onlyAdds(revision([check]),revision([{...check,checked:true}])));
 const photo={id:uuid(),kind:'image',assetId:image.assetId,caption:'下午'};
 assert(onlyAdds(revision([photo]),revision([{...photo,caption:'安静的下午'}])));
 assert(!onlyAdds(revision([photo]),revision([{...photo,caption:'早晨'}])));
 assert(!onlyAdds(revision([photo]),revision([{...photo,assetId:'b'.repeat(64)}])));
 assert(!onlyAdds(revision([text('第一段'),photo,text('第二段')]),revision([text('第二段'),photo,text('第一段')])));
});
test('legacy duplicate saves and merge records are hidden without removing raw data',()=>{
 const s=store(),a=raw(s,[text('最初')]),b=raw(s,[text('最初加一句')],[a.id]),duplicate=raw(s,[text('最初加一句')],[b.id]);
 const branch=raw(s,[text('最初加一句')],[b.id]);s.reconcileConflicts();
 assert.equal(s.versions(note).length,1);const final=save(s,[text('最初改一句')]);
 assert.equal(s.versions(note).length,2);assert(s.versions(note).some(r=>r.payload.blocks[0].text==='最初加一句'));
 const count=s.revisions.size,zip=s.backupBuffer(),restored=store();restored.restoreBackup(zip);
 assert.equal(restored.versions(note).length,2);assert.equal(restored.get(note).revision.payload.blocks[0].text,'最初改一句');
 for(const r of [a,b,duplicate,branch,final])assert(restored.revisions.has(r.id));assert.equal(s.revisions.size,count);validateGraph([...restored.revisions.values()]);
});
test('deletion retains the recoverable previous content and restoring it keeps first-edit time',()=>{
 const s=store();save(s,[text('第一句')]);const last=save(s,[text('第一句和第二句')]),first=s.get(note).firstEditedAt;
 save(s,null,{deleted:true,payload:null});assert(s.versions(note).some(r=>r.id===last.id));
 save(s,last.payload.blocks);assert.equal(s.get(note).firstEditedAt,first);assert.equal(s.versions(note).filter(r=>!r.deleted).length,1);
});
test('stale or concurrent save parents are never discarded by no-op detection',()=>{
 const s=store(),a=save(s,[text('原文')]);const b=save(s,[text('修改内容')]);
 const c=s.save({entityId:note,parents:[a.id],payload:{blocks:[text('修改内容')]}}).revision;
 assert.notEqual(b.id,c.id);assert.equal(s.get(note).heads.length,2);
 const resolved=save(s,[text('修改内容')]);assert.notEqual(resolved.id,b.id);assert.equal(s.get(note).heads.length,1);
});
test('unchanged future plans are no-ops while deleting an empty note remains a deletion',()=>{
 const s=store(),entityId='plan:'+uuid(),payload={kind:'once',title:'虚构安排',date:'2030-01-02',time:'',content:''};
 const plan=s.save({entityId,parents:[],payload}).revision;assert.equal(s.save({entityId,parents:[plan.id],payload}).revision.id,plan.id);
 const empty=save(s,[text('')]);const removed=save(s,null,{deleted:true,payload:null});assert.notEqual(removed.id,empty.id);assert(s.get(note).revision.deleted);
});
