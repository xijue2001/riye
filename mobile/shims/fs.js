import {Buffer} from 'buffer';
let next=1;const handles=new Map();
let initialFiles=null,initialDirs=null,assetNames=null;
export function primeFiles(snapshot){initialFiles=new Map(Object.entries(snapshot.files));initialDirs=new Map(Object.entries(snapshot.directories));assetNames=new Set(initialDirs.get('/data/assets')||[]);}
export function releaseFiles(){initialFiles=null;initialDirs=null;assetNames=null;}
export function disk(op,args={}){const r=JSON.parse(window.RiyeNative.fs(JSON.stringify({op,...args})));if(!r.ok)throw Error(r.error);return r.value;}
const adapter={
 mkdirSync:path=>disk('mkdir',{path}),
 existsSync:path=>{if(initialFiles?.has(path)||initialDirs?.has(path))return true;if(path.startsWith('/data/assets/')&&assetNames)return assetNames.has(path.slice(13));return disk('exists',{path});},
 readdirSync:path=>initialDirs?.has(path)?[...initialDirs.get(path)]:disk('list',{path}),
 readFileSync:(path,encoding)=>{if(initialFiles?.has(path)){const bytes=Buffer.from(initialFiles.get(path));return encoding?bytes.toString(encoding):bytes;}const bytes=Buffer.from(disk('read',{path}),'base64');return encoding?bytes.toString(encoding):bytes;},
 writeFileSync:(path,data)=>disk('write',{path:typeof path==='number'?handles.get(path):path,bytes:Buffer.from(data).toString('base64')}),
 openSync:(path,flag)=>{disk('create',{path,exclusive:flag==='wx'});const id=next++;handles.set(id,path);return id;},
 fsyncSync:()=>{},
 closeSync:id=>handles.delete(id),
 renameSync:(from,to)=>disk('rename',{from,to}),
 unlinkSync:path=>disk('remove',{path})
};
export default adapter;
export const {mkdirSync,existsSync,readdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync}=adapter;
