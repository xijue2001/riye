'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {uuid,localDate,validDate,validateRevision,heads,assetsOf,occurrence,sniffImage,validateGraph,hasNoteContent,validateDevice,selectHeads,contentKey}=require('./model.cjs');
const {historyVersions}=require('./history.cjs');
const {makeZip,readZip}=require('./zip.cjs');
function atomicWrite(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+uuid()+'.tmp';try{const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
class Store{
  constructor(root,{deviceName='电脑'}={}){
    this.root=root;this.revisions=new Map();this.entities=new Map();this.warnings=[];this.knownDevices=new Map();
    for(const dir of ['revisions','assets','backups','devices'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    const meta=path.join(root,'profile.json');if(fs.existsSync(meta))this.profile=JSON.parse(fs.readFileSync(meta,'utf8'));else{this.profile={deviceId:uuid(),datasetId:null};atomicWrite(meta,JSON.stringify(this.profile));}
    if(!this.profile.deviceName){this.profile.deviceName=deviceName;this.profile.deviceNameUpdatedAt=new Date().toISOString();atomicWrite(meta,JSON.stringify(this.profile));}
    for(const name of fs.readdirSync(path.join(root,'devices')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)))try{const d=validateDevice(JSON.parse(fs.readFileSync(path.join(root,'devices',name),'utf8')));if(name!==d.deviceId+'.json')throw Error();this.knownDevices.set(d.deviceId,d);}catch{this.warnings.push('一条设备名称无法读取');}
    this.importDevice(this.deviceInfo());
    for(const name of fs.readdirSync(path.join(root,'revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
      try{const r=validateRevision(JSON.parse(fs.readFileSync(path.join(root,'revisions',name),'utf8')));if(name!==r.id+'.json')throw Error();this.addIndex(r);}catch{this.warnings.push('一条本地记录无法读取：'+name);}
    }
    this.remote={revisions:[],assets:[],lastSync:null,lastError:null};
    const state=path.join(root,'sync-state.json');if(fs.existsSync(state)){try{this.remote=JSON.parse(fs.readFileSync(state,'utf8'));}catch{}}
    try{validateGraph([...this.revisions.values()]);this.reconcileConflicts();}catch(e){this.warnings.push('自动整理版本暂未完成：'+e.message);}
  }
  addIndex(r){this.revisions.set(r.id,r);if(!this.entities.has(r.entityId))this.entities.set(r.entityId,new Set());this.entities.get(r.entityId).add(r.id);}
  deviceInfo(){return validateDevice({format:'riye-device',schema:1,deviceId:this.profile.deviceId,name:this.profile.deviceName,updatedAt:this.profile.deviceNameUpdatedAt});}
  deviceList(){return [...this.knownDevices.values()];}
  importDevice(raw){const d=validateDevice(raw),old=this.knownDevices.get(d.deviceId);if(old&&old.updatedAt>d.updatedAt)return old;if(old&&JSON.stringify(old)===JSON.stringify(d))return old;atomicWrite(path.join(this.root,'devices',d.deviceId+'.json'),JSON.stringify(d));this.knownDevices.set(d.deviceId,d);return d;}
  setDeviceName(name){const d=validateDevice({...this.deviceInfo(),name,updatedAt:new Date(Math.max(Date.now(),Date.parse(this.profile.deviceNameUpdatedAt)+1)).toISOString()});this.profile.deviceName=d.name;this.profile.deviceNameUpdatedAt=d.updatedAt;atomicWrite(path.join(this.root,'profile.json'),JSON.stringify(this.profile));this.importDevice(d);return this.status();}
  setDataset(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('同步目录标识不正确');if(this.profile.datasetId&&this.profile.datasetId!==id)throw Error('此同步目录属于另一份数据，请检查 WebDAV 地址和目录');this.profile.datasetId=id;atomicWrite(path.join(this.root,'profile.json'),JSON.stringify(this.profile));}
  all(entityId){return [...(this.entities.get(entityId)||[])].map(id=>this.revisions.get(id));}
  versions(entityId){const current=this.get(entityId).revision?.id;return historyVersions(this.all(entityId)).map(r=>({...r,current:r.id===current}));}
  get(entityId){const all=this.all(entityId),h=heads(all);const first=all.filter(hasNoteContent).sort((a,b)=>a.timestamp.localeCompare(b.timestamp))[0];return{entityId,heads:h,...selectHeads(h),firstEditedAt:first?.timestamp||null};}
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
  importRevision(raw){const r=validateRevision(raw),existing=this.revisions.get(r.id);if(existing){if(JSON.stringify(existing)!==JSON.stringify(r))throw Error('发现编号相同但内容不同的记录');return existing;}atomicWrite(path.join(this.root,'revisions',r.id+'.json'),JSON.stringify(r));this.addIndex(r);return r;}
  save({entityId,payload,parents,deleted=false,firstEditedAt}){
    if(!Array.isArray(parents)||parents.some(id=>this.revisions.get(id)?.entityId!==entityId))throw Error('保存基于的版本不正确，请重新打开记录');
    let effectiveDate=localDate();
    if(entityId.startsWith('plan:')&&!this.entities.has(entityId)&&!deleted){if(payload.kind==='once')effectiveDate=payload.date;if(payload.kind==='weekly')effectiveDate=payload.startDate;if(payload.kind==='course')effectiveDate=payload.lessons.map(l=>l.date).sort()[0];}
    let timestamp=new Date().toISOString();
    if(entityId.endsWith(':diary')&&!deleted&&hasNoteContent({payload})&&!this.all(entityId).some(hasNoteContent)&&firstEditedAt){if(!Number.isFinite(Date.parse(firstEditedAt))||Date.parse(firstEditedAt)>Date.now()+5000)throw Error('首次编辑时间不正确');timestamp=new Date(firstEditedAt).toISOString();}
    const r=validateRevision({schema:1,id:uuid(),deviceId:this.profile.deviceId,entityId,parents,timestamp,effectiveDate,deleted,payload});
    const record=this.get(entityId);
    const sameParents=JSON.stringify([...new Set(parents)].sort())===JSON.stringify(record.heads.map(x=>x.id).sort());
    if(record.revision&&record.heads.length===1&&sameParents&&record.revision.deleted===r.deleted&&contentKey(record.revision)===contentKey({...r,effectiveDate:record.revision.effectiveDate}))return{revision:record.revision,record,status:this.status()};
    this.autoBackup();
    this.importRevision(r);return{revision:r,record:this.get(entityId),status:this.status()};
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
  status(){const r=new Set(this.remote.revisions||[]),a=new Set(this.remote.assets||[]);return{pendingRecords:[...this.revisions.keys()].filter(x=>!r.has(x)).length,pendingPhotos:this.assetIds().filter(x=>!a.has(x)).length,pendingDownloads:this.remote.pendingDownloads||0,pendingDevice:this.remote.deviceVersion!==this.profile.deviceNameUpdatedAt,deviceId:this.profile.deviceId,deviceName:this.profile.deviceName,devices:Object.fromEntries(this.deviceList().map(d=>[d.deviceId,d.name])),missingPhotos:[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!this.hasAsset(x)).length,conflicts:[...this.entities.keys()].filter(x=>this.get(x).conflict).length,lastSync:this.remote.lastSync,lastError:this.remote.lastError,warnings:this.warnings,root:this.root};}
  updateRemote(data){this.remote={...this.remote,...data};atomicWrite(path.join(this.root,'sync-state.json'),JSON.stringify(this.remote));}
  backupBuffer(){
    const missing=[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!this.hasAsset(x));if(missing.length)throw Error('还有 '+missing.length+' 张图片尚未下载，请同步后再导出完整备份');
    const entries=[['manifest.json',Buffer.from(JSON.stringify({format:'riye-backup',schema:1,exportedAt:new Date().toISOString(),datasetId:this.profile.datasetId,devices:this.deviceList()}))]];
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
    if(manifest.format!=='riye-backup'||manifest.schema!==1)throw Error('不是日页支持的备份');
    if(manifest.devices!==undefined&&(!Array.isArray(manifest.devices)||manifest.devices.length>10000))throw Error('备份中的设备信息不正确');const devices=(manifest.devices||[]).map(validateDevice);
    const revisions=[],assets=[];
    for(const [name,data]of entries){if(name==='manifest.json')continue;
      if(/^revisions\/[a-f0-9-]{36}\.json$/.test(name)){const r=validateRevision(JSON.parse(data));if(name!=='revisions/'+r.id+'.json')throw Error('备份记录编号不匹配');revisions.push(r);}
      else if(/^assets\/[a-f0-9]{64}\.bin$/.test(name)){const id=name.slice(7,-4);if(crypto.createHash('sha256').update(data).digest('hex')!==id)throw Error('备份图片校验失败');sniffImage(data);assets.push([id,name]);}
      else throw Error('备份包含不支持的文件');
    }
    const ids=new Set(revisions.map(r=>r.id)),assetIds=new Set(assets.map(x=>x[0]));
    if(ids.size!==revisions.length||revisions.some(r=>r.parents.some(id=>!ids.has(id))||assetsOf(r).some(id=>!assetIds.has(id))))throw Error('备份缺少记录或图片');
    validateGraph(revisions);
    // Validate existing identifiers before changing any local data.
    for(const r of revisions){const old=this.revisions.get(r.id);if(old&&JSON.stringify(old)!==JSON.stringify(r))throw Error('备份包含冲突的记录编号');}
    let before=null;if(this.revisions.size){before=path.join(this.root,'backups','before-restore-'+Date.now()+'.zip');this.exportBackup(before);}
    const byEntity=new Map();for(const r of revisions){if(!byEntity.has(r.entityId))byEntity.set(r.entityId,[]);byEntity.get(r.entityId).push(r);}
    const current=new Map([...byEntity.keys()].map(id=>[id,this.get(id).heads.map(r=>r.id)]));
    for(const [id,name]of assets)this.importAsset(id,entries.get(name));for(const r of revisions)this.importRevision(r);for(const d of devices)if(d.deviceId!==this.profile.deviceId)this.importDevice(d);
    for(const [entityId,list]of byEntity){const h=heads(list),parents=[...new Set([...current.get(entityId),...h.map(r=>r.id)])];for(const r of h)this.save({entityId,parents,payload:r.payload,deleted:r.deleted});}
    return {records:byEntity.size,photos:assets.length,before};
  }
}
module.exports={Store,atomicWrite};
