import {Buffer} from 'buffer';
let next=1;const handles=new Map();
export function disk(op,args={}){const r=JSON.parse(window.RiyeNative.fs(JSON.stringify({op,...args})));if(!r.ok)throw Error(r.error);return r.value;}
const adapter={
 mkdirSync:path=>disk('mkdir',{path}),
 existsSync:path=>disk('exists',{path}),
 readdirSync:path=>disk('list',{path}),
 readFileSync:(path,encoding)=>{const bytes=Buffer.from(disk('read',{path}),'base64');return encoding?bytes.toString(encoding):bytes;},
 writeFileSync:(path,data)=>disk('write',{path:typeof path==='number'?handles.get(path):path,bytes:Buffer.from(data).toString('base64')}),
 openSync:(path,flag)=>{disk('create',{path,exclusive:flag==='wx'});const id=next++;handles.set(id,path);return id;},
 fsyncSync:()=>{},
 closeSync:id=>handles.delete(id),
 renameSync:(from,to)=>disk('rename',{from,to}),
 unlinkSync:path=>disk('remove',{path})
};
export default adapter;
export const {mkdirSync,existsSync,readdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync}=adapter;
