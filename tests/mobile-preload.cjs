const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('RiyeNative',{fs:json=>ipcRenderer.sendSync('mobile-fs',json),request:json=>ipcRenderer.send('mobile-request',json),cancel:id=>ipcRenderer.send('mobile-cancel',id)});
