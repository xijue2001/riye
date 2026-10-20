'use strict';
const {app,BrowserWindow,ipcMain,protocol,dialog,shell,safeStorage,session}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const {Store,atomicWrite}=require('../core/store.cjs');const {Sync,Dav,normalizeConfig}=require('../core/dav.cjs');const {sniffImage,localDate}=require('../core/model.cjs');
const {AutoSync}=require('./auto-sync.cjs');
app.setName('日页');
protocol.registerSchemesAsPrivileged([{scheme:'daybook',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const testing=process.env.RIYE_TEST_MODE==='1'&&!!process.env.RIYE_DATA_DIR;
if(testing)app.setPath('userData',process.env.RIYE_DATA_DIR+'-electron');
if(!testing&&!app.requestSingleInstanceLock()){app.quit();}else{
let win,store,sync,config,autoSync,closeAllowed=false;
const notify=data=>{if(win&&!win.isDestroyed())win.webContents.send('sync-status',data);};
function readConfig(){
  const file=path.join(store.root,'connection.json');let value={primary:'',secondary:'',directory:'/sata2-2/riye',username:'',password:'',auto:true};
  if(fs.existsSync(file))try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));value={...value,...raw,password:''};if(raw.passwordEncrypted&&safeStorage.isEncryptionAvailable())value.password=safeStorage.decryptString(Buffer.from(raw.passwordEncrypted,'base64'));}catch{store.warnings.push('同步密码暂时无法读取，请在设置中重新填写');}
  return normalizeConfig(value);
}
function publicConfig(){return {...config,password:'',hasPassword:!!config.password};}
function changed(){notify({...store.status(),running:!!sync.running});}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{if(!event.senderFrame?.url.startsWith('daybook://app/'))return{ok:false,error:'页面来源不正确'};try{return{ok:true,value:await fn(...args)};}catch(e){return{ok:false,error:e.message};}});}
app.whenReady().then(async()=>{
  store=new Store(process.env.RIYE_DATA_DIR||path.join(app.getPath('userData'),'data-v1'));config=readConfig();sync=new Sync(store,notify);autoSync=new AutoSync(sync);
  protocol.handle('daybook',request=>{
    const u=new URL(request.url);
    if(u.hostname==='asset')try{const id=u.pathname.slice(1),bytes=store.readAsset(id);return new Response(bytes,{headers:{'Content-Type':sniffImage(bytes),'Cache-Control':'private, max-age=86400'}});}catch{return new Response('图片尚未下载',{status:404});}
    if(u.hostname!=='app')return new Response('',{status:404});
    const name=decodeURIComponent(u.pathname).replace(/^\//,'')||'index.html';const allowed=new Set(['index.html','app.js','style.css','icon.png']);
    if(!allowed.has(name))return new Response('',{status:404});
    const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',png:'image/png'}[name.split('.').at(-1)];
    return new Response(fs.readFileSync(path.join(__dirname,'../renderer',name)),{headers:{'Content-Type':mime}});
  });
  handle('init',()=>({config:publicConfig(),status:store.status(),version:app.getVersion()}));
  handle('day',day=>store.getDay(day));handle('history',()=>store.history());handle('plans',()=>store.plans());handle('versions',id=>store.versions(id));
  handle('save',data=>{const result=store.save(data);changed();return result;});handle('checkpoint',data=>{const result=store.checkpoint(data);changed();return result;});
  handle('day-delete',data=>{const result=store.deleteDay(data);changed();return result;});
  handle('device-name',name=>{const result=store.setDeviceName(name);changed();return result;});
  handle('image-add',data=>{const result=store.addAsset(data);changed();return result;});
  handle('image-pick',async()=>{const r=await dialog.showOpenDialog(win,{title:'加入照片或截图',properties:['openFile','multiSelections'],filters:[{name:'图片',extensions:['png','jpg','jpeg','webp','gif','bmp']}]});if(r.canceled)return[];return r.filePaths.map(file=>{if(fs.statSync(file).size>50*1024*1024)throw Error('单张图片请小于 50 MB');return store.addAsset(fs.readFileSync(file));});});
  handle('sync',()=>sync.run({...config}));
  handle('config-save',raw=>{
    if(sync.running)throw Error('请等待本次同步结束后再修改连接');
    const next=normalizeConfig({...raw,password:raw.password===''&&raw.keepPassword!==false?config.password:raw.password});
    const file={...next};delete file.password;
    if(next.password){if(!safeStorage.isEncryptionAvailable())throw Error('系统密码保护暂时不可用，无法安全保存同步密码');file.passwordEncrypted=safeStorage.encryptString(next.password).toString('base64');}
    atomicWrite(path.join(store.root,'connection.json'),JSON.stringify(file));config=next;autoSync.configure(config);store.updateRemote({lastError:null});changed();return publicConfig();
  });
  handle('connection-test',raw=>new Dav({...raw,password:raw.password||config.password}).test());
  handle('backup-export',async()=>{const r=await dialog.showSaveDialog(win,{title:'导出完整备份',defaultPath:'日页备份-'+localDate()+'.zip',filters:[{name:'完整备份',extensions:['zip']}]});if(r.canceled)return null;return store.exportBackup(r.filePath);});
  handle('backup-restore',async()=>{
    if(sync.running)throw Error('请等本次同步结束后再恢复备份');
    const r=await dialog.showOpenDialog(win,{title:'选择日页备份',properties:['openFile'],filters:[{name:'日页备份',extensions:['zip']}]});if(r.canceled)return null;
    const consent=await dialog.showMessageBox(win,{type:'question',buttons:['取消','恢复备份'],defaultId:0,cancelId:0,message:'恢复备份中的记录？',detail:'当前数据会先另存一份备份。备份中的记录将成为当前内容；备份中没有的记录继续保留，历史版本也会保留。'});if(consent.response!==1)return null;
    if(fs.statSync(r.filePaths[0]).size>1024*1024*1024)throw Error('备份文件过大');const result=store.restoreBackup(fs.readFileSync(r.filePaths[0]));changed();return result;
  });
  handle('open-data',()=>shell.openPath(store.root));handle('open-backups',()=>shell.openPath(path.join(store.root,'backups')));
  handle('close-ready',()=>{closeAllowed=true;win.close();});
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win=new BrowserWindow({show:!testing,width:1440,height:960,minWidth:1000,minHeight:720,title:'日页',icon:path.join(__dirname,'../renderer/icon.png'),backgroundColor:'#f6f7f3',autoHideMenuBar:true,webPreferences:{offscreen:testing,backgroundThrottling:!testing,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  win.on('close',event=>{if(!closeAllowed){event.preventDefault();win.webContents.send('before-close');}});
  await win.loadURL('daybook://app/index.html');store.autoBackup();autoSync.configure(config);
});
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.on('window-all-closed',()=>{autoSync?.stop();app.quit();});
}
