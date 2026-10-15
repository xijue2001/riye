import {Buffer} from 'buffer';
import packageInfo from '../package.json';
import {disk} from './shims/fs.js';
import storeModule from '../core/store.cjs';
import davModule from '../core/dav.cjs';
const {Store}=storeModule,{Sync,normalizeConfig}=davModule;
const pending=new Map(),listeners=[],closeListeners=[];
function nativeCall(op,args={},signal){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();if(signal?.aborted){reject(Error('连接已取消'));return;}const abort=()=>{pending.delete(id);window.RiyeNative.cancel(id);reject(Error('连接已取消'));};if(signal)signal.addEventListener('abort',abort,{once:true});pending.set(id,{resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)});window.RiyeNative.request(JSON.stringify({id,op,args}));});}
window.__riyeReply=r=>{const callback=pending.get(r.id);if(!callback)return;pending.delete(r.id);callback.cleanup();if(r.ok)callback.resolve(r.value);else callback.reject(Error(r.error));};
window.__riyePause=()=>window.dispatchEvent(new Event('riye-pause'));
window.__riyeBack=()=>window.dispatchEvent(new Event('riye-back'));
window.__riyeClose=()=>closeListeners.forEach(fn=>fn());
window.__riyeKeyboard=open=>document.body?.classList.toggle('keyboard-open',open);

// Network uses Android's HTTP client, so private HTTP WebDAV is independent of
// the local page origin, CORS and browser proxy settings.
globalThis.fetch=async(url,options={})=>{
 const result=await nativeCall('http',{url:String(url),method:options.method||'GET',headers:options.headers||{},body:options.body==null?null:Buffer.from(options.body).toString('base64')},options.signal);
 const bytes=Buffer.from(result.body||'','base64');
 const body={async *[Symbol.asyncIterator](){if(bytes.length)yield bytes;},cancel:async()=>{}};
 return {status:result.status,body,headers:new Headers(result.headers||{})};
};
let config=null;
const store=new Store('/data',{deviceName:'手机'});
function snapshot(){return{manifest:{format:'riye-backup',schema:1,exportedAt:new Date().toISOString(),datasetId:store.profile.datasetId,devices:store.deviceList()},revisionIds:[...store.revisions.keys()],assetIds:store.assetIds()};}
store.exportBackup=file=>{const missing=store.status().missingPhotos;if(missing)throw Error('还有 '+missing+' 张图片尚未下载，请先同步');disk('backup',{path:file,...snapshot()});return file;};
store.autoBackup=()=>{if(!store.revisions.size)return;try{disk('auto-backup',snapshot());}catch(e){store.warnings=['自动备份暂未完成：'+e.message];}};
const notify=data=>listeners.forEach(fn=>fn(data));
const sync=new Sync(store,notify);
function changed(){notify({...store.status(),running:!!sync.running});}
function publicConfig(){return {...config,password:'',hasPassword:!!config.password,auto:false};}
let imageToken=null,recovery=null;
async function recoverMedia(){if(imageToken||recovery)return recovery||false;recovery=(async()=>{
 const media=await nativeCall('pending-media');if(imageToken||!media||!media.images?.length||!/^note:\d{4}-\d{2}-\d{2}:(intent|diary)$/.test(media.entityId))return false;
 const record=store.get(media.entityId),blocks=structuredClone(record.revision?.payload?.blocks||[{id:crypto.randomUUID(),kind:'text',text:''}]);let count=0;
 for(const img of media.images)if(!blocks.some(b=>b.kind==='image'&&b.assetId===img.assetId)){blocks.push({id:crypto.randomUUID(),kind:'image',assetId:img.assetId,caption:''});count++;}
 if(count)store.save({entityId:media.entityId,parents:record.revision?[record.revision.id]:[],payload:{blocks}});
 await nativeCall('ack-media',{token:media.token});changed();return !!count;
})();try{return await recovery;}finally{recovery=null;}}
window.__riyeRecoverMedia=()=>recoverMedia().then(changed=>{if(changed)window.dispatchEvent(new Event('riye-reload'));}).catch(()=>{});
async function init(){if(!config)config=normalizeConfig({...await nativeCall('load-config'),auto:false});await recoverMedia();return{config:publicConfig(),status:store.status(),version:packageInfo.version+' Android'};}
async function restore(source){
 if(sync.running)throw Error('请等同步结束后再恢复备份');
 const result=await nativeCall('open-restore',{name:source||null});if(!result)return null;
 const entries={get:name=>Buffer.from(disk('zip-read',{name}),'base64'),*[Symbol.iterator](){for(const name of result.names)yield[name,this.get(name)];}};
 try{const restored=store.restoreEntries(entries);changed();return restored;}finally{disk('zip-close');}
}
window.daybook={
 platform:'android',assetUrl:id=>'https://appassets.androidplatform.net/data-assets/'+id,
 init,day:async day=>store.getDay(day),history:async()=>store.history(),plans:async()=>store.plans(),versions:async id=>store.all(id).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)),
 save:async data=>{const r=store.save(data);changed();return r;},addImage:async bytes=>{const r=store.addAsset(bytes);changed();return r;},pickImages:async context=>{const r=await nativeCall('pick-images',context);imageToken=r?.token||null;changed();return r?.images||[];},ackImages:async()=>{if(imageToken)await nativeCall('ack-media',{token:imageToken});imageToken=null;},
 deleteDay:async data=>{const r=store.deleteDay(data);changed();return r;},setDeviceName:async name=>{const r=store.setDeviceName(name);changed();return r;},
 sync:()=>sync.run({...config}),saveConfig:async raw=>{if(sync.running)throw Error('请等待同步结束后再修改连接');const next=normalizeConfig({...raw,password:raw.password===''&&raw.keepPassword!==false?config.password:raw.password,auto:false});await nativeCall('save-config',next);config=next;store.updateRemote({lastError:null});changed();return publicConfig();},
 testConnection:raw=>new davModule.Dav({...raw,password:raw.password||config.password,auto:false}).test(),
 exportBackup:()=>{if(store.status().missingPhotos)throw Error('还有图片尚未下载，请先同步');return nativeCall('export-backup',snapshot());},restoreBackup:()=>restore(),backups:()=>Promise.resolve(disk('list-backups')),restoreNamedBackup:name=>restore(name),
 openData:()=>nativeCall('storage-info'),openBackups:()=>Promise.resolve(disk('list-backups')),closeReady:()=>nativeCall('finish'),
 onSync:fn=>listeners.push(fn),onBeforeClose:fn=>closeListeners.push(fn)
};
