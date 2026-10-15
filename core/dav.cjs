'use strict';
const {uuid,validateRevision,validateGraph,assetsOf}=require('./model.cjs');
const crypto=require('node:crypto');
function normalizeConfig(raw){
  const out={primary:String(raw.primary||'').trim(),secondary:String(raw.secondary||'').trim(),directory:String(raw.directory||'').trim(),username:String(raw.username||''),password:String(raw.password||''),auto:raw.auto!==false};
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
    for(const dir of ['revisions','assets'])await ensureDir(this.root+dir+'/');
  }
  async list(dir){const url=this.root+dir+'/';const r=await this.request('PROPFIND',url,{headers:{Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',limit:32*1024*1024});return listing(r.body.toString('utf8'),url);}
  async get(file,max=128*1024*1024){return(await this.request('GET',this.root+file,{limit:max})).body;}
  async put(file,data,replace=false){return this.request('PUT',this.root+file,{body:data,headers:{'Content-Type':'application/octet-stream',...(!replace?{'If-None-Match':'*'}:{})},accept:[200,201,204,412]});}
  async dataset(store){
    let r=await this.request('GET',this.root+'info.json',{accept:[200,404],limit:10000});
    if(r.status===404){const info={format:'riye-sync',schema:1,datasetId:store.profile.datasetId||uuid()};await this.put('info.json',JSON.stringify(info));r=await this.request('GET',this.root+'info.json',{limit:10000});}
    let info;try{info=JSON.parse(r.body);}catch{throw Error('目录已存在其他内容，请使用应用专用同步目录');}
    if(info.format!=='riye-sync'||info.schema!==1)throw Error('目录不是日页的同步目录');store.setDataset(info.datasetId);
  }
  async test(){await this.connect();await this.ensure();const name='.connection-test-'+uuid()+'.txt',data=Buffer.from('riye-webdav-test');await this.put(name,data);const actual=await this.get(name,1000);if(!actual.equals(data))throw Error('文件写入校验失败');try{await this.request('DELETE',this.root+name,{accept:[200,204,404]});}catch{}return '目录读取、上传和下载测试成功';}
}
class Sync{
  constructor(store,notify=()=>{}){this.store=store;this.notify=notify;this.running=null;}
  async run(config){if(this.running)return this.running;this.running=this.perform(config);try{return await this.running;}finally{this.running=null;}}
  async perform(config){
    const store=this.store,dav=new Dav(config);const progress=(phase,current=0,total=0)=>this.notify({running:true,phase,current,total,...store.status()});
    try{
      progress('正在连接');await dav.connect();await dav.ensure();await dav.dataset(store);
      const remoteIds=(await dav.list('revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>n.slice(0,-5));
      const incoming=[],needed=remoteIds.filter(id=>!store.revisions.has(id));
      for(let i=0;i<needed.length;i++){progress('下载文字',i+1,needed.length);const data=await dav.get('revisions/'+needed[i]+'.json',4*1024*1024);const r=validateRevision(JSON.parse(data));if(r.id!==needed[i])throw Error('远程记录校验失败');incoming.push(r);}
      validateGraph([...store.revisions.values(),...incoming]);for(const r of incoming)store.importRevision(r);
      const remoteAssets=new Set((await dav.list('assets')).filter(n=>/^[a-f0-9]{64}\.bin$/.test(n)).map(n=>n.slice(0,-4)));
      const referenced=[...new Set([...store.revisions.values()].flatMap(assetsOf))];const photos=referenced.filter(id=>!store.hasAsset(id));
      for(let i=0;i<photos.length;i++){progress('下载照片',i+1,photos.length);if(!remoteAssets.has(photos[i]))throw Error('远程记录引用的图片还未上传，请稍后重试');store.importAsset(photos[i],await dav.get('assets/'+photos[i]+'.bin',50*1024*1024));}
      // A name left by a failed PUT is not proof of a completed transfer.
      const previouslyConfirmedAssets=new Set(store.remote.assets||[]);
      const uploads=store.assetIds().filter(id=>!remoteAssets.has(id)||!previouslyConfirmedAssets.has(id));
      for(let i=0;i<uploads.length;i++){
        progress('上传照片',i+1,uploads.length);const id=uploads[i],file='assets/'+id+'.bin',data=store.readAsset(id);const result=await dav.put(file,data);
        let actual=await dav.get(file,50*1024*1024);
        if(crypto.createHash('sha256').update(actual).digest('hex')!==id){
          if(result.status!==412)throw Error('远程照片写入校验失败，请重新同步');
          // Only repair a damaged file under the exact hash of our intact original.
          await dav.put(file,data,true);actual=await dav.get(file,50*1024*1024);
          if(crypto.createHash('sha256').update(actual).digest('hex')!==id)throw Error('远程照片写入校验失败，请重新同步');
        }remoteAssets.add(id);
      }
      const remoteSet=new Set(remoteIds),previouslyConfirmedRecords=new Set(store.remote.revisions||[]),revisions=[...store.revisions.values()].filter(r=>!remoteSet.has(r.id)||!previouslyConfirmedRecords.has(r.id));
      for(let i=0;i<revisions.length;i++){
        progress('上传文字',i+1,revisions.length);const r=revisions[i],file='revisions/'+r.id+'.json',data=JSON.stringify(r),result=await dav.put(file,data);let verified;
        const actual=await dav.get(file,4*1024*1024);
        try{verified=validateRevision(JSON.parse(actual));}catch(e){
          if(result.status!==412)throw e;
          // A valid differing revision is never replaced; a truncated JSON PUT can be retried.
          await dav.put(file,data,true);verified=validateRevision(JSON.parse(await dav.get(file,4*1024*1024)));
        }
        if(data!==JSON.stringify(verified))throw Error('远程记录写入校验失败');remoteSet.add(r.id);
      }
      // Listings confirm all files exist; edits made during this run remain queued.
      const confirmedRecords=(await dav.list('revisions')).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>n.slice(0,-5));
      const confirmedAssets=(await dav.list('assets')).filter(n=>/^[a-f0-9]{64}\.bin$/.test(n)).map(n=>n.slice(0,-4));
      store.updateRemote({revisions:confirmedRecords,assets:confirmedAssets,lastSync:new Date().toISOString(),lastError:null});store.autoBackup();const status=store.status();this.notify({running:false,phase:'同步结束',receivedRecords:incoming.length,...status});return status;
    }catch(e){store.updateRemote({lastError:e.message});this.notify({running:false,phase:'同步未完成',...store.status()});throw e;}
  }
}
module.exports={Dav,Sync,normalizeConfig,listing};
