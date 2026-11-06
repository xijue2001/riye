'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {uuid,localDate,validDate,validateRevision,heads,assetsOf,occurrence,sniffImage,validateGraph,hasNoteContent,validateDevice,selectHeads,contentKey}=require('./model.cjs');
const {historyVersions,validateCheckpoint,ancestorIds}=require('./history.cjs');
const {makeZip,readZip}=require('./zip.cjs');
const retention=require('./retention.cjs');
function atomicWrite(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+uuid()+'.tmp';try{const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
class Store{
  constructor(root,{deviceName='电脑'}={}){
    this.root=root;this.revisions=new Map();this.entities=new Map();this.checkpoints=new Map();this.warnings=[];this.knownDevices=new Map();this.records=new Map();this.retentionEvents=new Map();this.retired=new Map();this.firstEdited=new Map();this.retentionPolicy=null;
    const retentionFile=path.join(root,'retention.json');if(fs.existsSync(retentionFile)){const events=JSON.parse(fs.readFileSync(retentionFile,'utf8'));for(const raw of events){const e=retention.validateEvent(raw);this.retentionEvents.set(e.id,e);}this.setRetentionIndex();}
    this.pendingRetentions=new Map();const pendingFile=path.join(root,'retention-pending.json');if(fs.existsSync(pendingFile))for(const raw of JSON.parse(fs.readFileSync(pendingFile,'utf8'))){const e=retention.validateEvent(raw);this.pendingRetentions.set(e.id,e);}
    for(const dir of ['revisions','assets','backups','devices','checkpoints'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    const meta=path.join(root,'profile.json');if(fs.existsSync(meta))this.profile=JSON.parse(fs.readFileSync(meta,'utf8'));else{this.profile={deviceId:uuid(),datasetId:null};atomicWrite(meta,JSON.stringify(this.profile));}
    if(!this.profile.deviceName){this.profile.deviceName=deviceName;this.profile.deviceNameUpdatedAt=new Date().toISOString();atomicWrite(meta,JSON.stringify(this.profile));}
    for(const name of fs.readdirSync(path.join(root,'devices')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)))try{const d=validateDevice(JSON.parse(fs.readFileSync(path.join(root,'devices',name),'utf8')));if(name!==d.deviceId+'.json')throw Error();this.knownDevices.set(d.deviceId,d);}catch{this.warnings.push('一条设备名称无法读取');}
    this.importDevice(this.deviceInfo());
    for(const name of fs.readdirSync(path.join(root,'revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
      if(this.retired.has(name.slice(0,-5)))continue;
      try{const r=validateRevision(JSON.parse(fs.readFileSync(path.join(root,'revisions',name),'utf8')));if(name!==r.id+'.json')throw Error();this.addIndex(r);}catch{this.warnings.push('一条本地记录无法读取：'+name);}
    }
    for(const name of fs.readdirSync(path.join(root,'checkpoints')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)))try{const c=validateCheckpoint(JSON.parse(fs.readFileSync(path.join(root,'checkpoints',name),'utf8')));if(this.retired.has(c.revisionId))continue;if(name!==c.id+'.json'||this.revisions.get(c.revisionId)?.entityId!==c.entityId)throw Error();this.checkpoints.set(c.id,c);}catch{this.warnings.push('一个历史保存点无法读取');}
    this.remote={revisions:[],assets:[],checkpoints:[],lastSync:null,lastError:null};
    const state=path.join(root,'sync-state.json');if(fs.existsSync(state)){try{this.remote=JSON.parse(fs.readFileSync(state,'utf8'));}catch{}}
    try{validateGraph(this.graph());this.reconcileConflicts();}catch(e){this.warnings.push('自动整理版本暂未完成：'+e.message);}
  }
  addIndex(r){this.revisions.set(r.id,r);if(!this.entities.has(r.entityId))this.entities.set(r.entityId,new Set());this.entities.get(r.entityId).add(r.id);this.records.delete(r.entityId);}
  graph(revisions=[...this.revisions.values()]){return retention.graph(revisions,this.retired);}
  setRetentionIndex(){const state=retention.state([...this.retentionEvents.values()]);this.retired=state.retired;this.firstEdited=state.firstEditedAt;this.retentionPolicy=state.policy;this.records.clear();}
  queueRetention(e){this.pendingRetentions.set(e.id,e);atomicWrite(path.join(this.root,'retention-pending.json'),JSON.stringify([...this.pendingRetentions.values()]));}
  finishRetention(e){this.importRetention(e);this.pendingRetentions.delete(e.id);atomicWrite(path.join(this.root,'retention-pending.json'),JSON.stringify([...this.pendingRetentions.values()]));}
  importRetention(raw){
    const e=retention.validateEvent(raw),old=this.retentionEvents.get(e.id);if(old){if(JSON.stringify(old)!==JSON.stringify(e))throw Error('历史清理编号重复');return;}
    const next=new Map(this.retentionEvents);next.set(e.id,e);const index=retention.state([...next.values()]);validateGraph(retention.graph([...this.revisions.values()],index.retired));
    // Preserve an offline explicit save made against a revision another device
    // has already retired. Give it a fresh immutable identity before adoption.
    const saves=this.checkpointList().filter(c=>c.kind==='save'&&index.retired.has(c.revisionId)&&!(this.remote.checkpoints||[]).includes(c.id));
    for(const c of saves){const original=this.revisions.get(c.revisionId);if(!original)continue;const r=this.importRevision({...original,id:uuid(),parents:[original.id]});this.importCheckpoint({...c,id:uuid(),revisionId:r.id});}
    atomicWrite(path.join(this.root,'retention.json'),JSON.stringify([...next.values()]));this.retentionEvents=next;this.setRetentionIndex();
    for(const [id,r]of this.revisions)if(this.retired.has(id)){this.revisions.delete(id);this.entities.get(r.entityId)?.delete(id);}
    for(const [id,c]of this.checkpoints)if(this.retired.has(c.revisionId))this.checkpoints.delete(id);
    this.records.clear();
  }
  pruneFiles(){
    for(const name of fs.readdirSync(path.join(this.root,'checkpoints')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)&&!this.checkpoints.has(n.slice(0,-5)))){const file=path.join(this.root,'checkpoints',name);const c=JSON.parse(fs.readFileSync(file,'utf8'));if(this.retired.has(c.revisionId))fs.unlinkSync(file);}
    for(const name of fs.readdirSync(path.join(this.root,'revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)&&this.retired.has(n.slice(0,-5))))fs.unlinkSync(path.join(this.root,'revisions',name));
  }
  deviceInfo(){return validateDevice({format:'riye-device',schema:1,deviceId:this.profile.deviceId,name:this.profile.deviceName,updatedAt:this.profile.deviceNameUpdatedAt});}
  deviceList(){return [...this.knownDevices.values()];}
  importDevice(raw){const d=validateDevice(raw),old=this.knownDevices.get(d.deviceId);if(old&&old.updatedAt>d.updatedAt)return old;if(old&&JSON.stringify(old)===JSON.stringify(d))return old;atomicWrite(path.join(this.root,'devices',d.deviceId+'.json'),JSON.stringify(d));this.knownDevices.set(d.deviceId,d);return d;}
  setDeviceName(name){const d=validateDevice({...this.deviceInfo(),name,updatedAt:new Date(Math.max(Date.now(),Date.parse(this.profile.deviceNameUpdatedAt)+1)).toISOString()});this.profile.deviceName=d.name;this.profile.deviceNameUpdatedAt=d.updatedAt;atomicWrite(path.join(this.root,'profile.json'),JSON.stringify(this.profile));this.importDevice(d);return this.status();}
  setDataset(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('同步目录标识不正确');if(this.profile.datasetId&&this.profile.datasetId!==id)throw Error('此同步目录属于另一份数据，请检查 WebDAV 地址和目录');this.profile.datasetId=id;atomicWrite(path.join(this.root,'profile.json'),JSON.stringify(this.profile));}
  all(entityId){return this.graph([...(this.entities.get(entityId)||[])].map(id=>this.revisions.get(id)));}
  versions(entityId){const current=this.get(entityId).revision?.id;return historyVersions(this.all(entityId),this.checkpointList(entityId),!!this.retentionEvents.size).map(r=>({...r,current:r.id===current}));}
  get(entityId){if(this.records.has(entityId))return this.records.get(entityId);const all=this.all(entityId),h=heads(all);let first=this.firstEdited.get(entityId)||null;for(const r of all)if(hasNoteContent(r)&&(!first||r.timestamp<first))first=r.timestamp;const result={entityId,heads:h,...selectHeads(h),firstEditedAt:first};this.records.set(entityId,result);return result;}
  reconcileConflicts(){
    const merged=[];
    for(const entityId of this.entities.keys()){
      const record=this.get(entityId);if(record.heads.length<2||record.conflict)continue;
      let remaining=record.heads;
      while(remaining.length>1){
        const group=remaining.slice(0,100),parents=group.map(r=>r.id).sort(),source=record.revision;
        // All peers produce identical bytes and IDs for the same merge. Preserve
        // source attribution, first-edit history and a plan's effective date.
        const hex=crypto.createHash('sha256').update(JSON.stringify({format:'riye-auto-merge-v1',entityId,parents,source:source.id})).digest('hex');
        const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
        const timestamp=source.timestamp>group.at(-1).timestamp?source.timestamp:group.at(-1).timestamp;
        const r=this.importRevision({...source,id,parents,timestamp});merged.push(r);
        remaining=[r,...remaining.slice(100)].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
      }
    }
    return merged;
  }
  getDay(day){if(!validDate(day))throw Error('日期不正确');return{date:day,intent:this.get('note:'+day+':intent'),diary:this.get('note:'+day+':diary'),schedule:this.schedule(day)};}
  importRevision(raw){const r=validateRevision(raw),existing=this.revisions.get(r.id);if(this.retired.has(r.id))return r;if(existing){if(JSON.stringify(existing)!==JSON.stringify(r))throw Error('发现编号相同但内容不同的记录');return existing;}atomicWrite(path.join(this.root,'revisions',r.id+'.json'),JSON.stringify(r));this.addIndex(r);return r;}
  checkpointList(entityId){return [...this.checkpoints.values()].filter(c=>!entityId||c.entityId===entityId);}
  importCheckpoint(raw){const c=validateCheckpoint(raw);if(this.retired.has(c.revisionId))return c;if(this.revisions.get(c.revisionId)?.entityId!==c.entityId)throw Error('历史保存点缺少对应记录');const old=this.checkpoints.get(c.id);if(old){if(JSON.stringify(old)!==JSON.stringify(c))throw Error('历史保存点编号重复');return old;}atomicWrite(path.join(this.root,'checkpoints',c.id+'.json'),JSON.stringify(c));this.checkpoints.set(c.id,c);return c;}
  startManualHistory(revision){const ancestors=ancestorIds(revision,this.revisions);if(!this.checkpointList(revision.entityId).some(c=>c.kind==='start'&&ancestors.has(c.revisionId)))this.importCheckpoint({format:'riye-checkpoint',schema:1,id:uuid(),entityId:revision.entityId,revisionId:revision.id,deviceId:this.profile.deviceId,kind:'start',timestamp:new Date().toISOString()});}
  checkpoint({entityId,revisionId}){
    const r=this.revisions.get(revisionId);if(!r||r.entityId!==entityId||!entityId.startsWith('note:'))throw Error('请先保存当前内容，再保存版本');
    if(!hasNoteContent(r)&&!this.all(entityId).some(hasNoteContent))return{created:false,status:this.status()};
    const ancestors=ancestorIds(r,new Map(this.all(entityId).map(r=>[r.id,r]))),saved=this.checkpointList(entityId).filter(c=>c.kind==='save'&&ancestors.has(c.revisionId)).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id));
    if(saved.length&&this.revisions.get(saved[0].revisionId).deleted===r.deleted&&contentKey(this.revisions.get(saved[0].revisionId))===contentKey(r))return{created:false,status:this.status()};
    this.autoBackup();this.startManualHistory(r);const timestamp=new Date(Math.max(Date.now(),saved.length?Date.parse(saved[0].timestamp)+1:0)).toISOString();
    this.importCheckpoint({format:'riye-checkpoint',schema:1,id:uuid(),entityId,revisionId:r.id,deviceId:this.profile.deviceId,kind:'save',timestamp});return{created:true,status:this.status()};
  }
  save({entityId,payload,parents,deleted=false,firstEditedAt,historyMode}){
    if(historyMode!==undefined&&!['draft','manual'].includes(historyMode))throw Error('保存方式不正确');
    if(!Array.isArray(parents)||parents.some(id=>(this.revisions.get(id)||this.retired.get(id))?.entityId!==entityId))throw Error('保存基于的版本不正确，请重新打开记录');
    let effectiveDate=localDate();
    if(entityId.startsWith('plan:')&&!this.entities.has(entityId)&&!deleted){if(payload.kind==='once')effectiveDate=payload.date;if(payload.kind==='weekly')effectiveDate=payload.startDate;if(payload.kind==='course')effectiveDate=payload.lessons.map(l=>l.date).sort()[0];}
    let timestamp=new Date().toISOString();
    if(entityId.endsWith(':diary')&&!deleted&&hasNoteContent({payload})&&!this.all(entityId).some(hasNoteContent)&&firstEditedAt){if(!Number.isFinite(Date.parse(firstEditedAt))||Date.parse(firstEditedAt)>Date.now()+5000)throw Error('首次编辑时间不正确');timestamp=new Date(firstEditedAt).toISOString();}
    const r=validateRevision({schema:1,id:uuid(),deviceId:this.profile.deviceId,entityId,parents,timestamp,effectiveDate,deleted,payload});
    const record=this.get(entityId);
    const sameParents=JSON.stringify([...new Set(parents)].sort())===JSON.stringify(record.heads.map(x=>x.id).sort());
    let revision=r;
    if(record.revision&&record.heads.length===1&&sameParents&&record.revision.deleted===r.deleted&&contentKey(record.revision)===contentKey({...r,effectiveDate:record.revision.effectiveDate}))revision=record.revision;
    else{this.autoBackup();this.importRevision(r);}
    if(historyMode&&entityId.startsWith('note:')){this.startManualHistory(revision);if(historyMode==='manual')this.checkpoint({entityId,revisionId:revision.id});}
    return{revision,record:this.get(entityId),status:this.status()};
  }
  deleteDay({date,parents}){
    if(!validDate(date))throw Error('日期不正确');
    const records=['intent','diary'].map(kind=>({kind,record:this.get('note:'+date+':'+kind)}));
    for(const {kind,record} of records){const expected=parents?.[kind];if(!Array.isArray(expected)||expected.length>100||JSON.stringify([...expected].sort())!==JSON.stringify(record.heads.map(r=>r.id).sort()))throw Error('这一天的记录刚刚变化，请重新查看后再确认删除');}
    let removed=0;for(const {kind,record} of records)if(record.heads.some(r=>!r.deleted)){this.save({entityId:record.entityId,parents:parents[kind],deleted:true,payload:null});removed++;}
    return {removed,status:this.status()};
  }
  plans(){return [...this.entities.keys()].filter(id=>id.startsWith('plan:')).map(id=>this.get(id)).filter(x=>x.conflict||x.heads.some(r=>!r.deleted));}
  schedule(day){
    const entries=[];
    for(const id of this.entities.keys())if(id.startsWith('plan:')){
      const h=heads(this.all(id).filter(r=>r.effectiveDate<=day)),selection=selectHeads(h),r=selection.revision;
      if(r&&!r.deleted)for(const x of occurrence(r.payload,id,day))entries.push({...x,conflict:selection.conflict});
    }
    return entries.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99')||a.title.localeCompare(b.title,'zh-CN'));
  }
  history(){return [...new Set([...this.entities.keys()].filter(x=>x.startsWith('note:')).map(x=>x.split(':')[1]))].sort().reverse().map(day=>{const d={intent:this.get('note:'+day+':intent'),diary:this.get('note:'+day+':diary')};const active=[d.intent,d.diary].filter(x=>x.revision&&!x.revision.deleted);const text=active.map(x=>x.revision.payload.blocks.filter(b=>b.kind!=='image').map(b=>b.text).join(' ')).join(' ');return {date:day,preview:text.slice(0,180),text,hasIntent:hasNoteContent(d.intent.revision),hasDiary:hasNoteContent(d.diary.revision),firstEditedAt:d.diary.firstEditedAt,photos:active.reduce((n,x)=>n+x.revision.payload.blocks.filter(b=>b.kind==='image').length,0),conflict:d.intent.conflict||d.diary.conflict,deleted:active.length===0};});}
  assetIds(){return fs.readdirSync(path.join(this.root,'assets')).filter(x=>/^[a-f0-9]{64}\.bin$/.test(x)).map(x=>x.slice(0,-4));}
  addAsset(input){const buf=Buffer.from(input);if(buf.length>50*1024*1024)throw Error('单张图片请小于 50 MB');const mime=sniffImage(buf),id=crypto.createHash('sha256').update(buf).digest('hex');if(!this.hasAsset(id))atomicWrite(path.join(this.root,'assets',id+'.bin'),buf);return{assetId:id,mime,size:buf.length};}
  hasAsset(id){return /^[a-f0-9]{64}$/.test(id)&&fs.existsSync(path.join(this.root,'assets',id+'.bin'));}
  readAsset(id){if(!this.hasAsset(id))throw Error('图片尚未下载');return fs.readFileSync(path.join(this.root,'assets',id+'.bin'));}
  importAsset(id,buf){if(!/^[a-f0-9]{64}$/.test(id)||crypto.createHash('sha256').update(buf).digest('hex')!==id)throw Error('图片校验失败，请重试同步');return this.addAsset(buf);}
  status(){const r=new Set(this.remote.revisions||[]),a=new Set(this.remote.assets||[]),c=new Set(this.remote.checkpoints||[]),assets=new Set(this.assetIds());return{retentionEnabled:!!this.retentionPolicy&&this.retentionPolicy.mode!=="off",retentionProtocol:!!this.retentionEvents.size,retentionPolicy:this.retentionPolicy||retention.policy(),pendingRecords:[...this.revisions.keys()].filter(x=>!r.has(x)).length+[...this.checkpoints.keys()].filter(id=>!c.has(id)).length,pendingPhotos:[...assets].filter(x=>!a.has(x)).length,pendingDownloads:this.remote.pendingDownloads||0,pendingDevice:this.remote.deviceVersion!==this.profile.deviceNameUpdatedAt,deviceId:this.profile.deviceId,deviceName:this.profile.deviceName,devices:Object.fromEntries(this.deviceList().map(d=>[d.deviceId,d.name])),missingPhotos:[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!assets.has(x)).length,conflicts:[...this.entities.keys()].filter(x=>this.get(x).conflict).length,lastSync:this.remote.lastSync,lastError:this.remote.lastError,warnings:this.warnings,root:this.root};}
  updateRemote(data){this.remote={...this.remote,...data};atomicWrite(path.join(this.root,'sync-state.json'),JSON.stringify(this.remote));}
  backupBuffer(){
    const missing=[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!this.hasAsset(x));if(missing.length)throw Error('还有 '+missing.length+' 张图片尚未下载，请同步后再导出完整备份');
    const entries=[['manifest.json',Buffer.from(JSON.stringify({format:'riye-backup',schema:this.retentionEvents.size?2:1,exportedAt:new Date().toISOString(),datasetId:this.profile.datasetId,devices:this.deviceList(),history:this.checkpointList(),retention:[...this.retentionEvents.values()]}))]];
    for(const r of this.revisions.values())entries.push(['revisions/'+r.id+'.json',Buffer.from(JSON.stringify(r))]);
    for(const id of this.assetIds())entries.push(['assets/'+id+'.bin',this.readAsset(id)]);
    return makeZip(entries);
  }
  exportBackup(file){atomicWrite(file,this.backupBuffer());return file;}
  autoBackup(){
    if(!this.revisions.size)return;
    const file=path.join(this.root,'backups','daily-'+localDate()+'.zip');if(fs.existsSync(file))return;
    try{this.exportBackup(file);const names=fs.readdirSync(path.join(this.root,'backups')).filter(n=>/^daily-.*\.zip$/.test(n)).sort().reverse();for(const n of names.slice(7))fs.unlinkSync(path.join(this.root,'backups',n));}catch(e){this.warnings=['自动备份暂未完成：'+e.message];}
  }
  restoreBackup(buf){
    return this.restoreEntries(readZip(buf));
  }
  restoreEntries(entries){
    let manifest;try{manifest=JSON.parse(entries.get('manifest.json').toString());}catch{throw Error('缺少日页备份说明');}
    if(manifest.format!=='riye-backup'||![1,2].includes(manifest.schema))throw Error('不是日页支持的备份');
    if(manifest.devices!==undefined&&(!Array.isArray(manifest.devices)||manifest.devices.length>10000))throw Error('备份中的设备信息不正确');const devices=(manifest.devices||[]).map(validateDevice);
    const revisions=[],assets=[];
    for(const [name,data]of entries){if(name==='manifest.json')continue;
      if(/^revisions\/[a-f0-9-]{36}\.json$/.test(name)){const r=validateRevision(JSON.parse(data));if(name!=='revisions/'+r.id+'.json')throw Error('备份记录编号不匹配');revisions.push(r);}
      else if(/^assets\/[a-f0-9]{64}\.bin$/.test(name)){const id=name.slice(7,-4);if(crypto.createHash('sha256').update(data).digest('hex')!==id)throw Error('备份图片校验失败');sniffImage(data);assets.push([id,name]);}
      else throw Error('备份包含不支持的文件');
    }
    const ids=new Set(revisions.map(r=>r.id)),assetIds=new Set(assets.map(x=>x[0]));
    if(!Array.isArray(manifest.retention||[]))throw Error('备份中的历史清理记录不正确');const events=(manifest.retention||[]).map(retention.validateEvent),retired=retention.state(events).retired;
    if(ids.size!==revisions.length||revisions.some(r=>r.parents.some(id=>!ids.has(id)&&!retired.has(id))||assetsOf(r).some(id=>!assetIds.has(id))))throw Error('备份缺少记录或图片');
    validateGraph(retention.graph(revisions,retired));
    if(manifest.history!==undefined&&(!Array.isArray(manifest.history)||manifest.history.length>100000))throw Error('备份中的历史保存点不正确');
    const checkpoints=(manifest.history||[]).map(validateCheckpoint),index=new Map(revisions.map(r=>[r.id,r]));
    if(new Set(checkpoints.map(c=>c.id)).size!==checkpoints.length||checkpoints.some(c=>index.get(c.revisionId)?.entityId!==c.entityId))throw Error('备份中的历史保存点缺少记录');
    for(const c of checkpoints){const old=this.checkpoints.get(c.id);if(old&&JSON.stringify(old)!==JSON.stringify(c))throw Error('备份中的历史保存点编号重复');}
    // Validate existing identifiers before changing any local data.
    for(const r of revisions){const old=this.revisions.get(r.id);if(old&&JSON.stringify(old)!==JSON.stringify(r))throw Error('备份包含冲突的记录编号');}
    let before=null;if(this.revisions.size){before=path.join(this.root,'backups','before-restore-'+Date.now()+'.zip');this.exportBackup(before);}
    const byEntity=new Map();for(const r of revisions){if(!byEntity.has(r.entityId))byEntity.set(r.entityId,[]);byEntity.get(r.entityId).push(r);}
    const current=new Map([...byEntity.keys()].map(id=>[id,this.get(id).heads.map(r=>r.id)]));
    for(const [id,name]of assets)this.importAsset(id,entries.get(name));for(const r of revisions)this.importRevision(r);for(const e of events)this.importRetention(e);for(const c of checkpoints)this.importCheckpoint(c);for(const d of devices)if(d.deviceId!==this.profile.deviceId)this.importDevice(d);
    for(const [entityId,list]of byEntity){const h=heads(retention.graph(list,retired)),parents=[...new Set([...current.get(entityId),...h.map(r=>r.id)])];for(const r of h)this.save({entityId,parents,payload:r.payload,deleted:r.deleted});}
    return {records:byEntity.size,photos:assets.length,before};
  }
}
module.exports={Store,atomicWrite};
