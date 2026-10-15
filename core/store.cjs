'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {uuid,localDate,validDate,validateRevision,heads,assetsOf,occurrence,sniffImage,validateGraph}=require('./model.cjs');
const {makeZip,readZip}=require('./zip.cjs');
function atomicWrite(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+uuid()+'.tmp';try{const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
class Store{
  constructor(root){
    this.root=root;this.revisions=new Map();this.entities=new Map();this.warnings=[];
    for(const dir of ['revisions','assets','backups'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    const meta=path.join(root,'profile.json');if(fs.existsSync(meta))this.profile=JSON.parse(fs.readFileSync(meta,'utf8'));else{this.profile={deviceId:uuid(),datasetId:null};atomicWrite(meta,JSON.stringify(this.profile));}
    for(const name of fs.readdirSync(path.join(root,'revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
      try{const r=validateRevision(JSON.parse(fs.readFileSync(path.join(root,'revisions',name),'utf8')));if(name!==r.id+'.json')throw Error();this.addIndex(r);}catch{this.warnings.push('一条本地记录无法读取：'+name);}
    }
    this.remote={revisions:[],assets:[],lastSync:null,lastError:null};
    const state=path.join(root,'sync-state.json');if(fs.existsSync(state)){try{this.remote=JSON.parse(fs.readFileSync(state,'utf8'));}catch{}}
  }
  addIndex(r){this.revisions.set(r.id,r);if(!this.entities.has(r.entityId))this.entities.set(r.entityId,new Set());this.entities.get(r.entityId).add(r.id);}
  setDataset(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('同步目录标识不正确');if(this.profile.datasetId&&this.profile.datasetId!==id)throw Error('此同步目录属于另一份数据，请检查 WebDAV 地址和目录');this.profile.datasetId=id;atomicWrite(path.join(this.root,'profile.json'),JSON.stringify(this.profile));}
  all(entityId){return [...(this.entities.get(entityId)||[])].map(id=>this.revisions.get(id));}
  get(entityId){const h=heads(this.all(entityId));const visible=h.filter(r=>!r.deleted);return{entityId,heads:h,revision:visible.at(-1)||h.at(-1)||null,conflict:h.length>1};}
  getDay(day){if(!validDate(day))throw Error('日期不正确');return{date:day,intent:this.get('note:'+day+':intent'),diary:this.get('note:'+day+':diary'),schedule:this.schedule(day)};}
  importRevision(raw){const r=validateRevision(raw),existing=this.revisions.get(r.id);if(existing){if(JSON.stringify(existing)!==JSON.stringify(r))throw Error('发现编号相同但内容不同的记录');return existing;}atomicWrite(path.join(this.root,'revisions',r.id+'.json'),JSON.stringify(r));this.addIndex(r);return r;}
  save({entityId,payload,parents,deleted=false}){
    if(!Array.isArray(parents)||parents.some(id=>this.revisions.get(id)?.entityId!==entityId))throw Error('保存基于的版本不正确，请重新打开记录');
    this.autoBackup();
    let effectiveDate=localDate();
    if(entityId.startsWith('plan:')&&!this.entities.has(entityId)&&!deleted){if(payload.kind==='once')effectiveDate=payload.date;if(payload.kind==='weekly')effectiveDate=payload.startDate;if(payload.kind==='course')effectiveDate=payload.lessons.map(l=>l.date).sort()[0];}
    const r=validateRevision({schema:1,id:uuid(),deviceId:this.profile.deviceId,entityId,parents,timestamp:new Date().toISOString(),effectiveDate,deleted,payload});
    this.importRevision(r);return{revision:r,record:this.get(entityId),status:this.status()};
  }
  plans(){return [...this.entities.keys()].filter(id=>id.startsWith('plan:')).map(id=>this.get(id)).filter(x=>x.conflict||x.heads.some(r=>!r.deleted));}
  schedule(day){
    const entries=[];
    for(const id of this.entities.keys())if(id.startsWith('plan:')){
      const h=heads(this.all(id).filter(r=>r.effectiveDate<=day));const r=h.filter(r=>!r.deleted).at(-1);
      if(r)for(const x of occurrence(r.payload,id,day))entries.push({...x,conflict:h.length>1});
    }
    return entries.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99')||a.title.localeCompare(b.title,'zh-CN'));
  }
  history(){return [...new Set([...this.entities.keys()].filter(x=>x.startsWith('note:')).map(x=>x.split(':')[1]))].sort().reverse().map(day=>{const d=this.getDay(day);const text=[d.intent,d.diary].map(x=>x.revision?.payload?.blocks?.filter(b=>b.kind!=='image').map(b=>b.text).join(' ')||'').join(' ');return {date:day,preview:text.slice(0,180),text,photos:[d.intent,d.diary].reduce((n,x)=>n+(x.revision?.payload?.blocks?.filter(b=>b.kind==='image').length||0),0),conflict:d.intent.conflict||d.diary.conflict,deleted:[d.intent,d.diary].every(x=>!x.revision||x.revision.deleted)};});}
  assetIds(){return fs.readdirSync(path.join(this.root,'assets')).filter(x=>/^[a-f0-9]{64}\.bin$/.test(x)).map(x=>x.slice(0,-4));}
  addAsset(input){const buf=Buffer.from(input);if(buf.length>50*1024*1024)throw Error('单张图片请小于 50 MB');const mime=sniffImage(buf),id=crypto.createHash('sha256').update(buf).digest('hex');if(!this.hasAsset(id))atomicWrite(path.join(this.root,'assets',id+'.bin'),buf);return{assetId:id,mime,size:buf.length};}
  hasAsset(id){return /^[a-f0-9]{64}$/.test(id)&&fs.existsSync(path.join(this.root,'assets',id+'.bin'));}
  readAsset(id){if(!this.hasAsset(id))throw Error('图片尚未下载');return fs.readFileSync(path.join(this.root,'assets',id+'.bin'));}
  importAsset(id,buf){if(!/^[a-f0-9]{64}$/.test(id)||crypto.createHash('sha256').update(buf).digest('hex')!==id)throw Error('图片校验失败，请重试同步');return this.addAsset(buf);}
  status(){const r=new Set(this.remote.revisions||[]),a=new Set(this.remote.assets||[]);return{pendingRecords:[...this.revisions.keys()].filter(x=>!r.has(x)).length,pendingPhotos:this.assetIds().filter(x=>!a.has(x)).length,missingPhotos:[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!this.hasAsset(x)).length,conflicts:[...this.entities.keys()].filter(x=>this.get(x).conflict).length,lastSync:this.remote.lastSync,lastError:this.remote.lastError,warnings:this.warnings,root:this.root};}
  updateRemote(data){this.remote={...this.remote,...data};atomicWrite(path.join(this.root,'sync-state.json'),JSON.stringify(this.remote));}
  backupBuffer(){
    const missing=[...new Set([...this.revisions.values()].flatMap(assetsOf))].filter(x=>!this.hasAsset(x));if(missing.length)throw Error('还有 '+missing.length+' 张图片尚未下载，请同步后再导出完整备份');
    const entries=[['manifest.json',Buffer.from(JSON.stringify({format:'riye-backup',schema:1,exportedAt:new Date().toISOString(),datasetId:this.profile.datasetId}))]];
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
    for(const [id,name]of assets)this.importAsset(id,entries.get(name));for(const r of revisions)this.importRevision(r);
    for(const [entityId,list]of byEntity){const h=heads(list),parents=[...new Set([...current.get(entityId),...h.map(r=>r.id)])];for(const r of h)this.save({entityId,parents,payload:r.payload,deleted:r.deleted});}
    return {records:byEntity.size,photos:assets.length,before};
  }
}
module.exports={Store,atomicWrite};
