'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const call=(name,...args)=>ipcRenderer.invoke(name,...args).then(r=>{if(!r.ok)throw Error(r.error);return r.value;});
contextBridge.exposeInMainWorld('daybook',{
 init:()=>call('init'),day:d=>call('day',d),history:()=>call('history'),plans:()=>call('plans'),versions:id=>call('versions',id),save:x=>call('save',x),checkpoint:x=>call('checkpoint',x),
 deleteDay:data=>call('day-delete',data),setDeviceName:name=>call('device-name',name),
 addImage:bytes=>call('image-add',bytes),pickImages:()=>call('image-pick'),sync:()=>call('sync'),saveConfig:x=>call('config-save',x),testConnection:x=>call('connection-test',x),
 exportBackup:()=>call('backup-export'),restoreBackup:()=>call('backup-restore'),openData:()=>call('open-data'),openBackups:()=>call('open-backups'),closeReady:()=>call('close-ready'),
 onSync:fn=>ipcRenderer.on('sync-status',(_event,data)=>fn(data)),onBeforeClose:fn=>ipcRenderer.on('before-close',()=>fn())
});
