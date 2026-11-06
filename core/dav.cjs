'use strict';
const {uuid,validateRevision,validateGraph,assetsOf,validateDevice}=require('./model.cjs');
const crypto=require('node:crypto');
const {validateCheckpoint}=require('./history.cjs');
const retention=require('./retention.cjs');
function normalizeConfig(raw){
  const syncIntervalMinutes=raw.syncIntervalMinutes===undefined?5:Number(raw.syncIntervalMinutes);
  if(![5,10,15,30,60,120,240,360,480,720,1440].includes(syncIntervalMinutes))throw Error('请选择 5 分钟至 24 小时内的自动同步间隔');
  const out={primary:String(raw.primary||'').trim(),secondary:String(raw.secondary||'').trim(),directory:String(raw.directory||'').trim(),username:String(raw.username||''),password:String(raw.password||''),auto:raw.auto!==false,syncIntervalMinutes};
  for(const key of ['primary','secondary'])if(out[key]){let u;try{u=new URL(out[key]);}catch{throw Error('请填写完整服务地址，例如 http://100.x.x.x:6086');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('地址只支持 HTTP/HTTPS，账号密码请分开填写');out[key]=u.href.replace(/\/$/,'');}
  if(out.primary||out.secondary){const seg=out.directory.replace(/^\/+|\/+$/g,'').split('/');if(!seg.length||seg.some(s=>!s||s==='.'||s==='..')||out.directory.includes('\\')||out.directory.length>500)throw Error('请填写应用专用目录，不能使用根目录');}
  return out;
}
const xmlDecode=x=>x.replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
function listing(xml,url){
  const out=new Set(),base=new URL(url);base.pathname=base.pathname.replace(/\/?$/,'/');
  for(const response of xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)){
    const match=/<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(response[1]);if(!match)continue;
    let href;try{href=new URL(xmlDecode(match[1].trim()),base);}catch{continue;}
    if(href.origin!==base.origin||!href.pathname.startsWith(base.pathname))continue;
    let name;try{name=decodeURIComponent(href.pathname.slice(base.pathname.length));}catch{continue;}
    if(name&&!name.includes('/'))out.add(name);
  }
  return [...out];
}
// Read only successful properties of immediate children. Never follow a href
// outside the requested directory, even when a server returns absolute URLs.
function fileListing(xml,url){
  const base=new URL(url);base.pathname=base.pathname.replace(/\/?$/,'/');const entries=new Map();
  for(const response of xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)){
    const href=/<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(response[1]);if(!href)continue;
    let child,name;try{child=new URL(xmlDecode(href[1].trim()),base);name=decodeURIComponent(child.pathname.slice(base.pathname.length)).replace(/\/$/,'');}catch{continue;}
    if(child.origin!==base.origin||!child.pathname.startsWith(base.pathname)||!name||/[\/\\]/.test(name)||name==='.'||name==='..')continue;
    const props=[...response[1].matchAll(/<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat>/gi)].filter(p=>/<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/\S+\s+200\b/i.test(p[1])).map(p=>p[1]).join('');
    const size=/<(?:[\w.-]+:)?getcontentlength\b[^>]*>\s*(\d+)\s*<\//i.exec(props),directory=/<(?:[\w.-]+:)?collection\b/i.test(props)||child.pathname.endsWith('/');
    const bytes=size&&Number.isSafeInteger(Number(size[1]))?Number(size[1]):null;
    entries.set(name,{name,directory,bytes:directory?0:bytes});
  }return [...entries.values()];
}
class Dav{
  constructor(config){this.config=normalizeConfig(config);this.root=null;}
  rootFor(endpoint){return endpoint.replace(/\/$/,'')+'/'+this.config.directory.replace(/^\/+|\/+$/g,'').split('/').map(encodeURIComponent).join('/')+'/';}
  async request(method,url,{body,headers={},accept=[200,201,204,207],limit=128*1024*1024,timeout=20000}={}){
    const auth=Buffer.from(this.config.username+':'+this.config.password).toString('base64');let res;
    try{res=await fetch(url,{method,body,headers:{Authorization:'Basic '+auth,...headers},redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{throw Error('连接失败或超时，请确认服务地址、内网或 Tailscale 连接');}
    if(!accept.includes(res.status)){await res.body?.cancel();const msg={401:'账号或密码不正确',403:'目录没有读写权限',404:'同步文件或目录不存在',405:'服务不支持所需的 WebDAV 操作',409:'目录不存在或写入冲突',412:'记录已存在'};throw Object.assign(Error(msg[res.status]||'WebDAV 返回错误 '+res.status),{status:res.status});}
    let total=0;const parts=[];if(res.body)for await(const b of res.body){total+=b.length;if(total>limit){await res.body.cancel().catch(()=>{});throw Error('远程文件超过允许大小');}parts.push(Buffer.from(b));}
    return {status:res.status,body:Buffer.concat(parts),headers:res.headers};
  }
  async connect(){
    const endpoints=[...new Set([this.config.primary,this.config.secondary].filter(Boolean))];if(!endpoints.length)throw Error('请先在设置中填写 WebDAV 地址');let last;
    for(const endpoint of endpoints)try{
      const root=this.rootFor(endpoint);await this.request('PROPFIND',root,{headers:{Depth:'0','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',accept:[200,207,404],timeout:5000});this.root=root;return root;
    }catch(e){last=e;}
    throw last;
  }
  async ensure(){
    if(!this.root)await this.connect();const u=new URL(this.root),segments=u.pathname.split('/').filter(Boolean);let p='';
    const ensureDir=async url=>{const current=await this.request('PROPFIND',url,{headers:{Depth:'0','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',accept:[200,207,404]});if(current.status===404)await this.request('MKCOL',url,{accept:[200,201,204,405]});};
    for(const seg of segments){p+='/'+seg;await ensureDir(u.origin+p+'/');}
    for(const dir of ['revisions','assets','devices','checkpoints'])await ensureDir(this.root+dir+'/');
  }
  async list(dir){const url=this.root+dir+'/';const r=await this.request('PROPFIND',url,{headers:{Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',limit:32*1024*1024});return listing(r.body.toString('utf8'),url);}
  async files(dir=''){const url=this.root+(dir?dir+'/':'');const r=await this.request('PROPFIND',url,{headers:{Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',accept:[200,207,404],limit:32*1024*1024});return r.status===404?[]:fileListing(r.body.toString('utf8'),url);}
  async usage(){
    await this.connect();const info=JSON.parse(await this.get('info.json',10000));if(info.format!=='riye-sync'||![1,2].includes(info.schema))throw Error('目录不是日页的同步目录');
    const groups={revisions:{bytes:0,files:0,unknown:0},assets:{bytes:0,files:0,unknown:0},checkpoints:{bytes:0,files:0,unknown:0},other:{bytes:0,files:0,unknown:0}},queue=[{dir:'',group:'other'}];let folders=0;
    while(queue.length){if(++folders>1000)throw Error('目录过多，请检查日页专用目录');const {dir,group}=queue.shift();for(const entry of await this.files(dir)){
      const child=dir?dir+'/'+entry.name:entry.name,nextGroup=!dir&&Object.hasOwn(groups,entry.name)?entry.name:group;
      if(entry.directory){queue.push({dir:child,group:nextGroup});continue;}const g=groups[group];g.files++;if(entry.bytes===null)g.unknown++;else g.bytes+=entry.bytes;
    }}
    const values=Object.values(groups);return{checkedAt:new Date().toISOString(),datasetId:info.datasetId,groups,bytes:values.reduce((n,g)=>n+g.bytes,0),files:values.reduce((n,g)=>n+g.files,0),unknown:values.reduce((n,g)=>n+g.unknown,0)};
  }
  async get(file,max=128*1024*1024){return(await this.request('GET',this.root+file,{limit:max})).body;}
  async put(file,data,replace=false){return this.request('PUT',this.root+file,{body:data,headers:{'Content-Type':'application/octet-stream',...(!replace?{'If-None-Match':'*'}:{})},accept:[200,201,204,412]});}
  async dataset(store){
    let r=await this.request('GET',this.root+'info.json',{accept:[200,404],limit:10000});
    if(r.status===404){const info={format:'riye-sync',schema:1,datasetId:store.profile.datasetId||uuid()};await this.put('info.json',JSON.stringify(info));r=await this.request('GET',this.root+'info.json',{limit:10000});}
    let info;try{info=JSON.parse(r.body);}catch{throw Error('目录已存在其他内容，请使用应用专用同步目录');}
    if(info.format!=='riye-sync'||![1,2].includes(info.schema))throw Error('目录不是日页支持的同步目录，请检查应用版本');store.setDataset(info.datasetId);this.info=info;
  }
  async test(){await this.connect();await this.ensure();const name='.connection-test-'+uuid()+'.txt',data=Buffer.from('riye-webdav-test');await this.put(name,data);const actual=await this.get(name,1000);if(!actual.equals(data))throw Error('文件写入校验失败');try{await this.request('DELETE',this.root+name,{accept:[200,204,404]});}catch{}return '目录读取、上传和下载测试成功';}
}
class Sync{
  constructor(store,notify=()=>{}){this.store=store;this.notify=notify;this.running=null;}
  async run(config,maintenance=null){if(this.running){if(maintenance)throw Error('请等待本次同步结束');return this.running;}this.running=this.perform(config,maintenance);try{return await this.running;}finally{this.running=null;}}
  async pullRetentions(dav){
    const r=await dav.request('PROPFIND',dav.root+'retentions/',{headers:{Depth:'1','Content-Type':'application/xml'},accept:[200,207,404],limit:32*1024*1024});if(r.status===404)return;
    const events=[];for(const file of listing(r.body.toString(),dav.root+'retentions/').filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)))if(!this.store.retentionEvents.has(file.slice(0,-5))){const e=retention.validateEvent(JSON.parse(await dav.get('retentions/'+file,128*1024*1024)));if(file!==e.id+'.json')throw Error('历史清理编号不匹配');events.push(e);}
    events.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));for(const e of events)this.store.importRetention(e);
  }
  async pushRetentions(dav){
    if(!this.store.retentionEvents.size&&!this.store.pendingRetentions.size)return;
    if(dav.info.schema===1){await dav.put('info.json',JSON.stringify({...dav.info,schema:2}),true);const info=JSON.parse(await dav.get('info.json',10000));if(info.schema!==2||info.datasetId!==this.store.profile.datasetId)throw Error('历史清理索引同步准备失败');dav.info=info;}
    await dav.request('MKCOL',dav.root+'retentions/',{accept:[200,201,204,405]});
    const existing=new Set(await dav.list('retentions'));for(const e of this.store.retentionEvents.values())if(!existing.has(e.id+'.json'))await this.publishRetention(dav,e);
    for(const e of this.store.pendingRetentions.values()){await this.publishRetention(dav,e);this.store.finishRetention(e);}
  }
  async publishRetention(dav,e){
    const file='retentions/'+e.id+'.json',data=JSON.stringify(e),result=await dav.put(file,data);let verified;
    try{verified=retention.validateEvent(JSON.parse(await dav.get(file,128*1024*1024)));}catch(error){if(result.status!==412)throw error;await dav.put(file,data,true);verified=retention.validateEvent(JSON.parse(await dav.get(file,128*1024*1024)));}
    if(JSON.stringify(verified)!==data)throw Error('历史清理索引写入校验失败，未删除历史');
  }
  async preview(dav,raw){
    const plan=retention.plan(this.store,raw),counts={revisions:0,checkpoints:0,bytes:0,unknown:0},retired=new Set([...this.store.retired.keys(),...plan.retired.map(r=>r.id)]);
    for(const file of await dav.files('revisions'))if(retired.has(file.name.slice(0,-5))){counts.revisions++;if(file.bytes===null)counts.unknown++;else counts.bytes+=file.bytes;}
    for(const file of await dav.files('checkpoints')){if(!/^[a-f0-9-]{36}\.json$/.test(file.name))continue;const c=this.store.checkpoints.get(file.name.slice(0,-5))||validateCheckpoint(JSON.parse(await dav.get('checkpoints/'+file.name,10000)));if(retired.has(c.revisionId)){counts.checkpoints++;if(file.bytes===null)counts.unknown++;else counts.bytes+=file.bytes;}}
    const token=crypto.createHash('sha256').update(JSON.stringify({policy:plan.policy,ids:plan.retired.map(r=>r.id).sort(),events:[...this.store.retentionEvents.keys()].sort()})).digest('hex');return{...counts,histories:plan.histories,policy:plan.policy,token,checkedAt:new Date().toISOString(),remaining:plan.remaining};
  }
  async clean(dav,raw,expected){
    await this.pullRetentions(dav);const stamp=()=>JSON.stringify({r:[...this.store.revisions.keys()],c:[...this.store.checkpoints.keys()],e:[...this.store.retentionEvents.keys()]}),before=stamp();
    const preview=await this.preview(dav,raw);if(stamp()!==before||expected&&preview.token!==expected)throw Error('同步后内容已变化，请重新预览清理');
    const store=this.store,plan=retention.plan(store,raw),confirmed=new Set(store.remote.checkpoints);if(plan.retired.length||JSON.stringify(store.retentionPolicy)!==JSON.stringify(plan.policy)){
      // Retain visible legacy history as explicit markers before pruning drafts.
      for(const id of plan.visible){const r=store.revisions.get(id);if(!store.checkpointList(r.entityId).some(c=>c.kind==='save'&&c.revisionId===id))store.importCheckpoint({format:'riye-checkpoint',schema:1,id:uuid(),entityId:r.entityId,revisionId:id,deviceId:r.deviceId,kind:'save',timestamp:r.timestamp});}
      const removedIds=new Set(plan.retired.map(r=>r.id));for(const c of store.checkpointList())if(!removedIds.has(c.revisionId)&&!confirmed.has(c.id)){const file='checkpoints/'+c.id+'.json',data=JSON.stringify(c);await dav.put(file,data);if(JSON.stringify(validateCheckpoint(JSON.parse(await dav.get(file,10000))))!==data)throw Error('保留的历史版本写入校验失败');confirmed.add(c.id);}
      // Schema 2 makes older apps stop before reading a compacted graph.
      if(dav.info.schema===1){await dav.put('info.json',JSON.stringify({...dav.info,schema:2}),true);const info=JSON.parse(await dav.get('info.json',10000));if(info.schema!==2||info.datasetId!==store.profile.datasetId)throw Error('清理准备未完成，未删除历史');dav.info=info;}
      await dav.request('MKCOL',dav.root+'retentions/',{accept:[200,201,204,405]});
      const timestamp=new Date(Math.max(Date.now(),...([...store.retentionEvents.values()].map(e=>Date.parse(e.timestamp)+1)))).toISOString(),event=retention.eventFor(plan,timestamp);
      store.queueRetention(event);await this.publishRetention(dav,event);store.finishRetention(event);
    }
    // All deletions have an immutable, verified retirement event. Interrupted
    // deletes are retried; offline peers consume these events before uploading.
    const confirmedCheckpoints=[...confirmed];await this.pullRetentions(dav);let removed=0;
    for(const file of await dav.list('checkpoints'))if(/^[a-f0-9-]{36}\.json$/.test(file)&&!store.checkpoints.has(file.slice(0,-5))){const c=validateCheckpoint(JSON.parse(await dav.get('checkpoints/'+file,10000)));if(store.retired.has(c.revisionId)){await dav.request('DELETE',dav.root+'checkpoints/'+file,{accept:[200,204,404]});removed++;}}
    for(const file of await dav.list('revisions'))if(store.retired.has(file.slice(0,-5))){await dav.request('DELETE',dav.root+'revisions/'+file,{accept:[200,204,404]});removed++;}
    store.pruneFiles();return{...preview,removed,confirmedCheckpoints};
  }
  async perform(config,maintenance){
    const store=this.store,dav=new Dav(config);const progress=(phase,current=0,total=0)=>this.notify({running:true,phase,current,total,...store.status()});
    try{
      progress('正在连接');await dav.connect();await dav.ensure();await dav.dataset(store);await this.pushRetentions(dav);
      // Publish our label before our revisions, so a peer receiving those
      // revisions can already resolve their source device without another run.
      const own=store.deviceInfo(),deviceFile='devices/'+own.deviceId+'.json';
      const existingDevice=await dav.request('GET',dav.root+deviceFile,{accept:[200,404],limit:10000});
      let ownRemote=null;if(existingDevice.status===200)try{ownRemote=validateDevice(JSON.parse(existingDevice.body));}catch{}
      if(JSON.stringify(ownRemote)!==JSON.stringify(own)){await dav.put(deviceFile,JSON.stringify(own),true);const check=validateDevice(JSON.parse(await dav.get(deviceFile,10000)));if(JSON.stringify(check)!==JSON.stringify(own))throw Error('设备名称写入校验失败，请重试');}
      const confirmedRecords=new Set(store.remote.revisions||[]),confirmedAssets=new Set(store.remote.assets||[]),confirmedCheckpoints=new Set(store.remote.checkpoints||[]),received=new Set(),receivedCheckpoints=new Set();
      let remoteIds=[],remoteAssets=new Set(),remoteCheckpoints=new Set();
      const pull=async()=>{
        await this.pullRetentions(dav);
        remoteCheckpoints=new Set((await dav.list('checkpoints')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>n.slice(0,-5)));
        const events=[];for(const id of remoteCheckpoints)if(!store.checkpoints.has(id)){const c=validateCheckpoint(JSON.parse(await dav.get('checkpoints/'+id+'.json',10000)));if(c.id!==id)throw Error('远程历史保存点编号不匹配');if(!store.retired.has(c.revisionId))events.push(c);}
        remoteIds=(await dav.list('revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)&&!store.retired.has(n.slice(0,-5))).map(n=>n.slice(0,-5));
        const incoming=new Map(),needed=[...new Set([...remoteIds,...events.map(c=>c.revisionId)])].filter(id=>!store.revisions.has(id)),queued=new Set(needed);
        for(let i=0;i<needed.length;i++){
          progress('下载文字',i+1,needed.length);const id=needed[i],r=validateRevision(JSON.parse(await dav.get('revisions/'+id+'.json',4*1024*1024)));
          if(r.id!==id)throw Error('远程记录校验失败');incoming.set(id,r);
          // A listing can race a peer's upload. Fetch its causal parents too.
          const parents=store.graph([r])[0].parents;for(const parent of parents)if(!store.revisions.has(parent)&&!queued.has(parent)){queued.add(parent);needed.push(parent);}
        }
        validateGraph(store.graph([...store.revisions.values(),...incoming.values()]));
        for(const c of events)if((incoming.get(c.revisionId)||store.revisions.get(c.revisionId))?.entityId!==c.entityId)throw Error('远程历史保存点缺少对应记录');
        for(const r of incoming.values()){store.importRevision(r);confirmedRecords.add(r.id);received.add(r.id);}
        for(const c of events){store.importCheckpoint(c);confirmedCheckpoints.add(c.id);receivedCheckpoints.add(c.id);}
        remoteAssets=new Set((await dav.list('assets')).filter(n=>/^[a-f0-9]{64}\.bin$/.test(n)).map(n=>n.slice(0,-4)));
        const photos=[...new Set([...store.revisions.values()].flatMap(assetsOf))].filter(id=>!store.hasAsset(id));
        for(let i=0;i<photos.length;i++){progress('下载照片',i+1,photos.length);const id=photos[i];if(!remoteAssets.has(id))throw Error('远程记录引用的图片还未上传，请稍后重试');store.importAsset(id,await dav.get('assets/'+id+'.bin',50*1024*1024));confirmedAssets.add(id);}
        store.reconcileConflicts();
      };
      await pull();
      // Freeze one outgoing snapshot so an edit made mid-transfer cannot publish
      // a revision before its new image or parent has reached the server.
      const snapshot=validateGraph(store.graph()).map(r=>store.revisions.get(r.id)),snapshotIds=new Set(snapshot.map(r=>r.id)),checkpointSnapshot=store.checkpointList().filter(c=>snapshotIds.has(c.revisionId)),uploads=store.assetIds().filter(id=>!remoteAssets.has(id)||!confirmedAssets.has(id));
      for(let i=0;i<uploads.length;i++){
        progress('上传照片',i+1,uploads.length);const id=uploads[i],file='assets/'+id+'.bin',data=store.readAsset(id);const result=await dav.put(file,data);
        let actual=await dav.get(file,50*1024*1024);
        if(crypto.createHash('sha256').update(actual).digest('hex')!==id){
          if(result.status!==412)throw Error('远程照片写入校验失败，请重新同步');
          // Only repair a damaged file under the exact hash of our intact original.
          await dav.put(file,data,true);actual=await dav.get(file,50*1024*1024);
          if(crypto.createHash('sha256').update(actual).digest('hex')!==id)throw Error('远程照片写入校验失败，请重新同步');
        }remoteAssets.add(id);confirmedAssets.add(id);
      }
      // Causal order is important after a restart, when disk filenames are random.
      const remoteSet=new Set(remoteIds),revisions=snapshot.filter(r=>!remoteSet.has(r.id)||!confirmedRecords.has(r.id));
      for(let i=0;i<revisions.length;i++){
        progress('上传文字',i+1,revisions.length);const r=revisions[i],file='revisions/'+r.id+'.json',data=JSON.stringify(r),result=await dav.put(file,data);let verified;
        const actual=await dav.get(file,4*1024*1024);
        try{verified=validateRevision(JSON.parse(actual));}catch(e){
          if(result.status!==412)throw e;
          // A valid differing revision is never replaced; a truncated JSON PUT can be retried.
          await dav.put(file,data,true);verified=validateRevision(JSON.parse(await dav.get(file,4*1024*1024)));
        }
        if(data!==JSON.stringify(verified))throw Error('远程记录写入校验失败');remoteSet.add(r.id);confirmedRecords.add(r.id);
      }
      // Publish history markers after their immutable revisions and photos.
      for(const c of checkpointSnapshot)if(!remoteCheckpoints.has(c.id)||!confirmedCheckpoints.has(c.id)){
        const file='checkpoints/'+c.id+'.json',data=JSON.stringify(c),result=await dav.put(file,data);let verified;
        try{verified=validateCheckpoint(JSON.parse(await dav.get(file,10000)));}catch(e){if(result.status!==412)throw e;await dav.put(file,data,true);verified=validateCheckpoint(JSON.parse(await dav.get(file,10000)));}
        if(data!==JSON.stringify(verified))throw Error('远程历史保存点写入校验失败');confirmedCheckpoints.add(c.id);
      }
      // A second device may have uploaded since our first listing. Pull again,
      // with a bound so continuous remote typing cannot keep this run alive forever.
      for(let round=0;round<2;round++)await pull();
      progress('同步设备名称');
      for(const file of (await dav.list('devices')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
        const d=validateDevice(JSON.parse(await dav.get('devices/'+file,10000)));if(file!==d.deviceId+'.json')throw Error('远程设备编号不匹配');
        if(d.deviceId!==own.deviceId)store.importDevice(d);
      }
      const finalRecords=(await dav.list('revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)&&!store.retired.has(n.slice(0,-5))).map(n=>n.slice(0,-5));
      const finalAssets=(await dav.list('assets')).filter(n=>/^[a-f0-9]{64}\.bin$/.test(n)).map(n=>n.slice(0,-4));
      const finalCheckpoints=(await dav.list('checkpoints')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>n.slice(0,-5));
      const pendingDownloads=finalRecords.filter(id=>!store.revisions.has(id)).length+finalCheckpoints.filter(id=>!store.checkpoints.has(id)&&!remoteCheckpoints.has(id)).length;
      // File names alone never certify a transfer, including interrupted PUTs.
      store.updateRemote({revisions:finalRecords.filter(id=>confirmedRecords.has(id)),assets:finalAssets.filter(id=>confirmedAssets.has(id)),checkpoints:finalCheckpoints.filter(id=>confirmedCheckpoints.has(id)),pendingDownloads,deviceVersion:own.updatedAt,lastError:null});
      const pending=store.status();if(!pending.pendingRecords&&!pending.pendingPhotos&&!pending.missingPhotos&&!pending.pendingDownloads&&!pending.pendingDevice)store.updateRemote({lastSync:new Date().toISOString()});
      let cleanup=null;const ready=store.status();if(maintenance&&(ready.pendingRecords||ready.pendingPhotos||ready.missingPhotos||ready.pendingDownloads||ready.pendingDevice))throw Error('还有内容未同步完成，请同步后再预览清理');
      if(maintenance?.preview)cleanup=await this.preview(dav,maintenance.preview);
      else if(maintenance?.apply)cleanup=await this.clean(dav,maintenance.apply.policy,maintenance.apply.token);
      else if(store.retentionPolicy?.mode&&store.retentionPolicy.mode!=='off'&&!ready.pendingRecords&&!ready.pendingPhotos&&!ready.pendingDownloads&&!ready.missingPhotos&&!ready.pendingDevice)cleanup=await this.clean(dav,store.retentionPolicy);
      if(cleanup&&!maintenance?.preview){store.updateRemote({revisions:store.remote.revisions.filter(id=>store.revisions.has(id)),checkpoints:[...new Set([...store.remote.checkpoints,...(cleanup.confirmedCheckpoints||[])])].filter(id=>store.checkpoints.has(id))});}
      store.autoBackup();const status=store.status();this.notify({running:false,phase:'同步结束',receivedRecords:received.size+receivedCheckpoints.size,...status});return maintenance?{...cleanup,status}:status;
    }catch(e){store.updateRemote({lastError:e.message});this.notify({running:false,phase:'同步未完成',...store.status()});throw e;}
  }
}
module.exports={Dav,Sync,normalizeConfig,listing,fileListing};
